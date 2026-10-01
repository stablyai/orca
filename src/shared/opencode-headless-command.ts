// Why: `opencode run` answers one prompt and exits, so its process lifetime is its turn.
// Not in agent-headless-command's table: that would also drop OpenCode 1 `run`'s identity,
// whose in-process plugin reports it. Only `--log-level` takes a separate value before the
// subcommand; any other valued option makes the value the first positional, which fails safe.
export function isOpenCodeRunCommand(tokens: readonly string[]): boolean {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token.startsWith('-')) {
      return token === 'run'
    }
    if (token === '--log-level') {
      index += 1
    }
  }
  return false
}
