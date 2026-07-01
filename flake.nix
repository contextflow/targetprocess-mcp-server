{
  description = "Targetprocess MCP server with Linux bubblewrap and macOS Seatbelt runtimes";

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
      linuxSystems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      darwinSystems = [
        "aarch64-darwin"
        "x86_64-darwin"
      ];
      systems = linuxSystems ++ darwinSystems;
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          lib = pkgs.lib;

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

          makeProxyLauncher =
            {
              name,
              runtimeInputs ? [ ],
              runServer,
            }:
            pkgs.writeShellApplication {
              inherit name;
              runtimeInputs = [
                pkgs.coreutils
                pkgs.socat
                pkgs.tinyproxy
              ] ++ runtimeInputs;
              text = ''
                if [ -z "''${TP_BASE_URL:-}" ]; then
                  echo "TP_BASE_URL is required" >&2
                  exit 1
                fi

                if [ -z "''${TP_TOKEN:-}" ]; then
                  echo "TP_TOKEN is required" >&2
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

                ${runServer}
              '';
            };

          linuxPackages = lib.optionalAttrs pkgs.stdenv.isLinux (
            let
              jail = jail-nix.lib.init pkgs;
              jailed-node = jail "targetprocess-mcp-server-jailed-node" targetprocess-mcp-server (
                c: with c; [
                  (ro-bind (noescape "\"$TP_PROXY_SOCKET_DIR\"") (noescape "\"$TP_PROXY_SOCKET_DIR\""))
                  (ro-bind "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt" "/etc/ssl/certs/ca-bundle.crt")
                  (set-env "SSL_CERT_FILE" "/etc/ssl/certs/ca-bundle.crt")
                  (set-env "NODE_EXTRA_CA_CERTS" "/etc/ssl/certs/ca-bundle.crt")
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
              jailed = makeProxyLauncher {
                name = "targetprocess-mcp-server-jailed";
                runServer = ''
                  "${jailed-node}/bin/targetprocess-mcp-server-jailed-node" "$@"
                '';
              };
            in
            {
              default = jailed;
              jailed = jailed;
            }
          );

          darwinPackages = lib.optionalAttrs pkgs.stdenv.isDarwin (
            let
              seatbelt = makeProxyLauncher {
                name = "targetprocess-mcp-server-seatbelt";
                runServer = ''
                  if [ ! -x /usr/bin/sandbox-exec ]; then
                    echo "macOS Seatbelt runtime requires /usr/bin/sandbox-exec" >&2
                    exit 1
                  fi

                  TP_SEATBELT_PROFILE="$TP_PROXY_CONFIG_DIR/seatbelt.sb"
                  cat > "$TP_SEATBELT_PROFILE" <<'EOF'
                (version 1)
                (deny default)

                (allow process-fork)
                (allow process-exec)
                (allow signal (target same-sandbox))
                (allow process-info* (target same-sandbox))
                (allow sysctl-read)
                (allow sysctl-write (sysctl-name "kern.grade_cputype"))
                (allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))
                (allow ipc-posix-sem)
                (allow mach-lookup
                  (global-name "com.apple.PowerManagement.control")
                  (global-name "com.apple.SecurityServer")
                  (global-name "com.apple.SystemConfiguration.DNSConfiguration")
                  (global-name "com.apple.SystemConfiguration.configd")
                  (global-name "com.apple.bsd.dirhelper")
                  (global-name "com.apple.cfprefsd.agent")
                  (global-name "com.apple.cfprefsd.daemon")
                  (global-name "com.apple.networkd")
                  (global-name "com.apple.ocspd")
                  (global-name "com.apple.system.DirectoryService.libinfo_v1")
                  (global-name "com.apple.system.logger")
                  (global-name "com.apple.system.opendirectoryd.libinfo")
                  (global-name "com.apple.system.opendirectoryd.membership")
                  (global-name "com.apple.trustd.agent")
                  (local-name "com.apple.cfprefsd.agent"))

                (allow file-map-executable
                  (subpath "/Library/Apple/System/Library/Frameworks")
                  (subpath "/Library/Apple/System/Library/PrivateFrameworks")
                  (subpath "/Library/Apple/usr/lib")
                  (subpath "/System/Library/Extensions")
                  (subpath "/System/Library/Frameworks")
                  (subpath "/System/Library/PrivateFrameworks")
                  (subpath "/System/Library/SubFrameworks")
                  (subpath "/System/iOSSupport/System/Library/Frameworks")
                  (subpath "/System/iOSSupport/System/Library/PrivateFrameworks")
                  (subpath "/System/iOSSupport/System/Library/SubFrameworks")
                  (subpath "/usr/lib")
                  (subpath "/nix/store"))

                (allow file-read*
                  (literal "/")
                  (literal "/dev")
                  (literal "/dev/null")
                  (literal "/dev/random")
                  (literal "/dev/tty")
                  (literal "/dev/urandom")
                  (literal "/dev/zero")
                  (literal "/etc")
                  (literal "/private/etc/localtime")
                  (literal "/tmp")
                  (literal "/var")
                  (subpath "/Library/Apple")
                  (subpath "/Library/Filesystems/NetFSPlugins")
                  (subpath "/Library/Preferences")
                  (subpath "/System/Library/CoreServices")
                  (subpath "/System/Library/Frameworks")
                  (subpath "/System/Library/PrivateFrameworks")
                  (subpath "/bin")
                  (subpath "/dev/fd")
                  (subpath "/nix/store")
                  (subpath "/private/etc")
                  (subpath "/private/var/db")
                  (subpath "/private/var/tmp")
                  (subpath "/sbin")
                  (subpath "/usr/bin")
                  (subpath "/usr/lib")
                  (subpath "/usr/libexec")
                  (subpath "/usr/sbin")
                  (subpath "/usr/share")
                  (subpath "/var/db")
                  (subpath "/var/tmp")
                  (subpath (param "TP_PROXY_SOCKET_DIR")))

                (allow file-read-metadata
                  (literal "/System/Volumes")
                  (literal "/System/Volumes/Data")
                  (literal "/System/Volumes/Data/Users")
                  (subpath "/private")
                  (subpath "/var"))

                (allow file-read-data file-test-existence file-write-data
                  (subpath "/dev/fd"))
                (allow file-read* file-write*
                  (literal "/dev/null")
                  (literal "/dev/tty"))
                (allow file-write*
                  (subpath (param "TP_PROXY_SOCKET_DIR"))
                  (subpath (param "TMPDIR")))
                (allow file-ioctl
                  (literal "/dev/ptmx")
                  (regex #"^/dev/ttys[0-9]+$"))
                (allow file-read* file-write*
                  (literal "/dev/ptmx")
                  (regex #"^/dev/ttys[0-9]+$"))

                (allow system-socket (socket-domain AF_UNIX))
                (allow system-socket
                  (require-all
                    (socket-domain AF_SYSTEM)
                    (socket-protocol 2)))
                (allow network-bind
                  (local unix-socket (subpath (param "TP_PROXY_SOCKET_DIR"))))
                (allow network-outbound
                  (remote unix-socket (subpath (param "TP_PROXY_SOCKET_DIR"))))
                EOF

                  export SSL_CERT_FILE="${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
                  export NODE_EXTRA_CA_CERTS="${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
                  /usr/bin/sandbox-exec \
                    -f "$TP_SEATBELT_PROFILE" \
                    -D "TP_PROXY_SOCKET_DIR=$TP_PROXY_SOCKET_DIR" \
                    -D "TMPDIR=''${TMPDIR:-/tmp}" \
                    -- \
                    "${targetprocess-mcp-server}/bin/targetprocess-mcp-server" "$@"
                '';
              };
            in
            {
              default = seatbelt;
              seatbelt = seatbelt;
            }
          );
        in
        {
          unjailed = targetprocess-mcp-server;
        } // linuxPackages // darwinPackages
      );

      apps = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          lib = pkgs.lib;
          defaultProgram =
            if pkgs.stdenv.isDarwin then
              "targetprocess-mcp-server-seatbelt"
            else
              "targetprocess-mcp-server-jailed";
        in
        {
          default = {
            type = "app";
            program = "${self.packages.${system}.default}/bin/${defaultProgram}";
            meta.description = "Sandboxed Targetprocess MCP server";
          };
          unjailed = {
            type = "app";
            program = "${self.packages.${system}.unjailed}/bin/targetprocess-mcp-server";
            meta.description = "Unjailed Targetprocess MCP server";
          };
        }
        // lib.optionalAttrs pkgs.stdenv.isLinux {
          jailed = {
            type = "app";
            program = "${self.packages.${system}.jailed}/bin/targetprocess-mcp-server-jailed";
            meta.description = "Linux bubblewrap-jailed Targetprocess MCP server";
          };
        }
        // lib.optionalAttrs pkgs.stdenv.isDarwin {
          seatbelt = {
            type = "app";
            program = "${self.packages.${system}.seatbelt}/bin/targetprocess-mcp-server-seatbelt";
            meta.description = "macOS Seatbelt-sandboxed Targetprocess MCP server";
          };
        }
      );

      checks = forAllSystems (system: {
        inherit (self.packages.${system}) default unjailed;
      });
    };
}
