// Why: `muse exec` runs one prompt headlessly and exits, so a pane running it
// must not classify as the interactive Muse TUI. Only the bare `exec`
// subcommand token counts — a quoted TUI prompt that starts with "exec" stays
// one token and never matches.
export function isMuseHeadlessOneShotCommand(tokens: readonly string[]): boolean {
  return tokens[1]?.toLowerCase() === 'exec'
}
