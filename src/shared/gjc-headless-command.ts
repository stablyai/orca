const GJC_PRINT_MODE_FLAGS = new Set(['--print', '-p'])

function optionName(token: string): string {
  const eq = token.indexOf('=')
  return eq === -1 ? token : token.slice(0, eq)
}

// Why: `gjc -p/--print` is Gajae Code's documented non-interactive mode
// (process prompt and exit), so those launches are one-shots, not hosted TUIs.
export function isGjcHeadlessOneShotCommand(tokens: readonly string[]): boolean {
  for (let index = 1; index < tokens.length; index += 1) {
    if (GJC_PRINT_MODE_FLAGS.has(optionName(tokens[index]))) {
      return true
    }
  }
  return false
}
