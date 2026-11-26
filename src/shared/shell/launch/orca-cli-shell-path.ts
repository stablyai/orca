// Login profiles can rebuild PATH; re-add Orca's CLI first and Orca's own agent copies last.
export const ORCA_CLI_POSIX_PATH_RESTORE = `if [ -n "\${ORCA_CLI_BIN_DIR:-}" ]; then
  case "\${PATH:-}" in
    "$ORCA_CLI_BIN_DIR"|"$ORCA_CLI_BIN_DIR":*) ;;
    *) export PATH="$ORCA_CLI_BIN_DIR\${PATH:+:$PATH}" ;;
  esac
fi
if [ -n "\${ORCA_MANAGED_AGENT_PATH:-}" ]; then
  case ":\${PATH:-}:" in
    *":$ORCA_MANAGED_AGENT_PATH:"*) ;;
    *) export PATH="\${PATH:+$PATH:}$ORCA_MANAGED_AGENT_PATH" ;;
  esac
fi`
