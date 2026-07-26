const TRAE_PRINT_MODE_FLAGS = new Set(['--print', '-p'])
const TRAE_HEADLESS_OUTPUT_FORMATS = new Set(['json', 'stream-json'])

function optionName(token: string): string {
  const eq = token.indexOf('=')
  return eq === -1 ? token : token.slice(0, eq)
}

function optionValue(tokens: readonly string[], index: number): string | null {
  const token = tokens[index]
  const eq = token.indexOf('=')
  if (eq !== -1) {
    return token.slice(eq + 1)
  }
  return tokens[index + 1] ?? null
}

// Why: `trae-cli --print`/`-p` runs a single response and exits (same
// contract as `claude --print`), and `--output-format json|stream-json` is
// only meaningful for that one-shot mode. Either signal means the spawned
// process is a headless invocation, not the interactive TUI session Orca
// hosts, so it must not be recognized as a live agent pane.
export function isTraeHeadlessOneShotCommand(tokens: readonly string[]): boolean {
  for (let index = 1; index < tokens.length; index += 1) {
    const name = optionName(tokens[index])
    if (TRAE_PRINT_MODE_FLAGS.has(name)) {
      return true
    }
    if (name === '--output-format') {
      const value = optionValue(tokens, index)?.toLowerCase()
      if (value && TRAE_HEADLESS_OUTPUT_FORMATS.has(value)) {
        return true
      }
    }
  }
  return false
}
