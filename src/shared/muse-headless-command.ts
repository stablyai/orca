// Why: `muse exec` runs one prompt headlessly and exits, so a pane running it
// must not classify as the interactive Muse TUI. `exec` matches past any position:
// `muse exec …` dispatches headless while `muse <flags> exec …` fails fast with an
// arg error — neither ever hosts the TUI. The match stays case-sensitive because
// subcommand dispatch is (`muse 'EXEC'` is a TUI prompt), and a quoted TUI prompt
// never splits into an `exec` token on its own.
export function isMuseHeadlessOneShotCommand(tokens: readonly string[]): boolean {
  return tokens.slice(1).some((token) => token === 'exec')
}
