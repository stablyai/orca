export const ORCA_CLI_POSIX_PATH_RESTORE = `if [ -n "\${ORCA_CLI_BIN_DIR:-}" ]; then
  case "\${PATH:-}" in
    "$ORCA_CLI_BIN_DIR"|"$ORCA_CLI_BIN_DIR":*) ;;
    *) export PATH="$ORCA_CLI_BIN_DIR\${PATH:+:$PATH}" ;;
  esac
fi`
