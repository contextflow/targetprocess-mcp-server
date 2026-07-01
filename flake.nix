{
  description = "Targetprocess MCP server with a jail.nix bubblewrap runtime";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    jail-nix.url = "git+https://git.sr.ht/~alexdavid/jail.nix";
  };

  outputs =
    {
      self,
      nixpkgs,
      jail-nix,
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          jail = jail-nix.lib.init pkgs;

          targetprocess-mcp-server = pkgs.buildNpmPackage {
            pname = "targetprocess-mcp-server";
            version = "2.5.0";
            src = self;

            nodejs = pkgs.nodejs_22;
            npmDepsHash = "sha256-ULYwcFwLBoBXBIYdWpZyO6ZSIYzPwC9BLNYu7XZXOI0=";
            npmInstallFlags = [ "--ignore-scripts" ];

            meta = {
              description = "MCP server for Targetprocess";
              mainProgram = "targetprocess-mcp-server";
            };
          };

          jailed-node = jail "targetprocess-mcp-server-jailed-node" targetprocess-mcp-server (
            c: with c; [
              (ro-bind (noescape "\"$TP_PROXY_SOCKET_DIR\"") (noescape "\"$TP_PROXY_SOCKET_DIR\""))
              (fwd-env "TP_BASE_URL")
              (fwd-env "TP_TOKEN")
              (fwd-env "TP_PROXY_SOCKET")
              (try-fwd-env "TP_OWNER_ID")
              (try-fwd-env "TP_PROJECT_ID")
              (try-fwd-env "TP_TEAM_ID")
              (try-fwd-env "TP_PROCESS_ID")
              (try-fwd-env "TP_USER_STORY_WORKFLOW_ID")
              (try-fwd-env "TP_BUG_WORKFLOW_ID")
              (try-fwd-env "TP_DEBUG_HTTP")
            ]
          );

          jailed = pkgs.writeShellApplication {
            name = "targetprocess-mcp-server-jailed";
            runtimeInputs = [
              pkgs.coreutils
              pkgs.socat
              pkgs.tinyproxy
            ];
            text = ''
              if [ -z "''${TP_BASE_URL:-}" ]; then
                echo "TP_BASE_URL is required" >&2
                exit 1
              fi

              case "$TP_BASE_URL" in
                https://*) ;;
                *)
                  echo "TP_BASE_URL must use https://" >&2
                  exit 1
                  ;;
              esac

              case "$TP_BASE_URL" in
                *[[:space:]]*|*@*|*\?*|*\#*)
                  echo "TP_BASE_URL must not contain whitespace, credentials, query strings, or fragments" >&2
                  exit 1
                  ;;
              esac

              tp_without_scheme="''${TP_BASE_URL#https://}"
              tp_host="''${tp_without_scheme%%/*}"
              if [ -z "$tp_host" ]; then
                echo "TP_BASE_URL must include a host" >&2
                exit 1
              fi

              case "$tp_host" in
                *:*)
                  echo "TP_BASE_URL must use the default HTTPS port 443" >&2
                  exit 1
                  ;;
                *[!A-Za-z0-9.-]*|.*|*.|*..*|-*)
                  echo "TP_BASE_URL host contains unsupported characters" >&2
                  exit 1
                  ;;
              esac

              TP_PROXY_SOCKET_DIR="$(mktemp -d "''${TMPDIR:-/tmp}/targetprocess-mcp-proxy-socket.XXXXXX")"
              export TP_PROXY_SOCKET_DIR
              TP_PROXY_CONFIG_DIR="$(mktemp -d "''${TMPDIR:-/tmp}/targetprocess-mcp-proxy-config.XXXXXX")"
              TP_PROXY_SOCKET="$TP_PROXY_SOCKET_DIR/proxy.sock"
              export TP_PROXY_SOCKET

              proxy_filter="$TP_PROXY_CONFIG_DIR/filter"
              proxy_config="$TP_PROXY_CONFIG_DIR/tinyproxy.conf"
              printf '%s\n' "$tp_host" > "$proxy_filter"

              cleanup() {
                if [ -n "''${socat_pid:-}" ]; then kill "$socat_pid" 2>/dev/null || true; fi
                if [ -n "''${tinyproxy_pid:-}" ]; then kill "$tinyproxy_pid" 2>/dev/null || true; fi
                if [ -n "''${socat_pid:-}" ]; then wait "$socat_pid" 2>/dev/null || true; fi
                if [ -n "''${tinyproxy_pid:-}" ]; then wait "$tinyproxy_pid" 2>/dev/null || true; fi
                rm -rf "$TP_PROXY_SOCKET_DIR" "$TP_PROXY_CONFIG_DIR"
              }
              trap cleanup EXIT INT TERM

              tinyproxy_pid=""
              for attempt in $(seq 1 25); do
                proxy_port="$((30000 + (($$ + ''${RANDOM:-0} + attempt) % 20000)))"

                cat > "$proxy_config" <<EOF
              Port $proxy_port
              Listen 127.0.0.1
              Timeout 600
              LogLevel Warning
              MaxClients 20
              Allow 127.0.0.1
              Filter "$proxy_filter"
              FilterType fnmatch
              FilterDefaultDeny Yes
              ConnectPort 443
              DisableViaHeader Yes
              EOF

                tinyproxy -d -c "$proxy_config" &
                tinyproxy_pid=$!
                tinyproxy_ready=0

                for _ in $(seq 1 50); do
                  if ! kill -0 "$tinyproxy_pid" 2>/dev/null; then
                    break
                  fi
                  if (echo > "/dev/tcp/127.0.0.1/$proxy_port") >/dev/null 2>&1; then
                    tinyproxy_ready=1
                    break
                  fi
                  sleep 0.1
                done

                if [ "$tinyproxy_ready" = 1 ] && kill -0 "$tinyproxy_pid" 2>/dev/null; then
                  break
                fi

                kill "$tinyproxy_pid" 2>/dev/null || true
                wait "$tinyproxy_pid" 2>/dev/null || true
                tinyproxy_pid=""
              done

              if [ -z "$tinyproxy_pid" ]; then
                echo "Failed to start tinyproxy allowlist proxy" >&2
                exit 1
              fi

              socat "UNIX-LISTEN:$TP_PROXY_SOCKET,fork,mode=0600,unlink-early" "TCP:127.0.0.1:$proxy_port" &
              socat_pid=$!

              socket_ready=0
              for _ in $(seq 1 50); do
                if ! kill -0 "$socat_pid" 2>/dev/null; then
                  break
                fi
                if [ -S "$TP_PROXY_SOCKET" ]; then
                  socket_ready=1
                  break
                fi
                sleep 0.1
              done

              if [ "$socket_ready" != 1 ]; then
                echo "Failed to start private proxy socket bridge" >&2
                exit 1
              fi

              "${jailed-node}/bin/targetprocess-mcp-server-jailed-node" "$@"
            '';
          };
        in
        {
          default = jailed;
          unjailed = targetprocess-mcp-server;
        }
      );

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/targetprocess-mcp-server-jailed";
        };
        unjailed = {
          type = "app";
          program = "${self.packages.${system}.unjailed}/bin/targetprocess-mcp-server";
        };
      });

      checks = forAllSystems (system: {
        inherit (self.packages.${system}) default unjailed;
      });
    };
}
