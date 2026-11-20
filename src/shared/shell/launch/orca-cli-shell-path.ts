// Login profiles can rebuild PATH; re-add Orca's CLI first and Orca's own agent copies last,
// though before any Windows-drive entry on a WSL host, whose shims that host can't run.
export const ORCA_CLI_POSIX_PATH_RESTORE = `if [ -n "\${ORCA_CLI_BIN_DIR:-}" ]; then
  case "\${PATH:-}" in
    "$ORCA_CLI_BIN_DIR"|"$ORCA_CLI_BIN_DIR":*) ;;
    *) export PATH="$ORCA_CLI_BIN_DIR\${PATH:+:$PATH}" ;;
  esac
fi
if [ -n "\${ORCA_MANAGED_AGENT_PATH:-}" ]; then
  case ":\${PATH:-}:" in
    *":$ORCA_MANAGED_AGENT_PATH:"*) ;;
    *)
      orca_rest="\${PATH:-}"; orca_path=; orca_placed=
      while [ -n "$orca_rest" ]; do
        orca_entry="\${orca_rest%%:*}"
        case "$orca_rest" in *:*) orca_rest="\${orca_rest#*:}" ;; *) orca_rest= ;; esac
        orca_mounts="\${ORCA_WINDOWS_DRIVE_MOUNTS:-}"
        while [ -z "$orca_placed" ] && [ -n "$orca_mounts" ]; do
          orca_mount="\${orca_mounts%%:*}"
          case "$orca_mounts" in *:*) orca_mounts="\${orca_mounts#*:}" ;; *) orca_mounts= ;; esac
          case "$orca_entry/" in
            "$orca_mount"/*) orca_path="\${orca_path:+$orca_path:}$ORCA_MANAGED_AGENT_PATH"; orca_placed=1 ;;
          esac
        done
        orca_path="\${orca_path:+$orca_path:}$orca_entry"
      done
      [ -n "$orca_placed" ] || orca_path="\${orca_path:+$orca_path:}$ORCA_MANAGED_AGENT_PATH"
      export PATH="$orca_path"
      unset orca_rest orca_path orca_placed orca_entry orca_mounts orca_mount ;;
  esac
fi`
