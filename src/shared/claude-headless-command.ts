const CLAUDE_PRINT_MODE_FLAGS = new Set(['--print', '-p'])
const CLAUDE_HEADLESS_OUTPUT_FORMATS = new Set(['json', 'stream-json'])

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

export function isClaudeHeadlessOneShotCommand(tokens: readonly string[]): boolean {
  for (let index = 1; index < tokens.length; index += 1) {
    const name = optionName(tokens[index])
    if (CLAUDE_PRINT_MODE_FLAGS.has(name)) {
      return true
    }
    if (name === '--output-format') {
      const value = optionValue(tokens, index)?.toLowerCase()
      if (value && CLAUDE_HEADLESS_OUTPUT_FORMATS.has(value)) {
        return true
      }
    }
  }
  return false
}
