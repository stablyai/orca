// Any exact exec token prevents the TUI: muse exec runs headlessly; flags before exec fail argument parsing.
// Match case-sensitively (EXEC can be a TUI prompt); a longer quoted prompt stays one token.
export function isMuseHeadlessOneShotCommand(tokens: readonly string[]): boolean {
  return tokens.slice(1).some((token) => token === 'exec')
}
