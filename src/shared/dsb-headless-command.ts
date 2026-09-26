function isDsbScriptEntrypoint(token: string): boolean {
  const base = token.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  return (
    base === 'dsb.js' || base === 'dsb.mjs' || base === 'dsb.cjs' || base === 'deepseek-build.js'
  )
}

// Why: `dsb run` exits after one message. Bare `dsb` and `dsb agent` stay in the TUI.
// The npm shim is `node …/dsb.js`, so the script path sits ahead of the subcommand.
export function isDsbHeadlessOneShotCommand(tokens: readonly string[]): boolean {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token || token === '--') {
      return false
    }
    if (token.startsWith('-') || isDsbScriptEntrypoint(token)) {
      continue
    }
    return token === 'run'
  }
  return false
}
