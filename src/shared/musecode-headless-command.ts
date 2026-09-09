// Why: `muse exec …` runs one prompt headless and exits, while bare `muse`
// (and `muse resume`) hosts the interactive TUI Orca panes run.
// A bare `exec` token dispatches as the subcommand even past `--` (verified:
// `muse -- resume` still resumes), so there is no terminator to stop at —
// match it anywhere. A quoted multi-word prompt stays one token and never
// equals `exec`; a whole-prompt `muse 'exec'` takes the exec missing-prompt
// error path, not a TUI, so filtering it is still correct.
export function isMusecodeHeadlessOneShotCommand(tokens: readonly string[]): boolean {
  return tokens.slice(1).some((token) => token === 'exec')
}
