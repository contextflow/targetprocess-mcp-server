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
            npmDepsHash = "sha256-bz0gmLOUBlD4wvMT5lznfId38c7XCSrcMBYWxN22BvE=";
            npmInstallFlags = [ "--ignore-scripts" ];

            meta = {
              description = "MCP server for Targetprocess";
              mainProgram = "targetprocess-mcp-server";
            };
          };

          jailed = jail "targetprocess-mcp-server-jailed" targetprocess-mcp-server (
            c: with c; [
              network
              (fwd-env "TP_BASE_URL")
              (fwd-env "TP_TOKEN")
              (try-fwd-env "TP_OWNER_ID")
              (try-fwd-env "TP_PROJECT_ID")
              (try-fwd-env "TP_TEAM_ID")
              (try-fwd-env "TP_PROCESS_ID")
              (try-fwd-env "TP_USER_STORY_WORKFLOW_ID")
              (try-fwd-env "TP_BUG_WORKFLOW_ID")
              (try-fwd-env "TP_DEBUG_HTTP")
            ]
          );
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
