const GJC_PRINT_MODE_FLAGS = new Set(['--print', '-p'])
// Why: `gjc --mode` selects machine output modes consumed by wrappers and
// subprocess workers (rpc is Gajae Code's documented worker mode); only the
// default `text` mode hosts the interactive TUI. `rpc-ui` is conservatively
// treated as interactive so a live UI-attached session is never hidden.
const GJC_HEADLESS_MODES = new Set(['json', 'rpc', 'acp', 'bridge'])

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

export function isGjcHeadlessOneShotCommand(tokens: readonly string[]): boolean {
  for (let index = 1; index < tokens.length; index += 1) {
    const name = optionName(tokens[index])
    if (GJC_PRINT_MODE_FLAGS.has(name)) {
      return true
    }
    if (name === '--mode') {
      const value = optionValue(tokens, index)?.toLowerCase()
      if (value && GJC_HEADLESS_MODES.has(value)) {
        return true
      }
    }
  }
  return false
}
