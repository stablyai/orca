/** The resolved `--model <id>` (or `--model=<id>`) tokens, without any other launch option. */
export function antigravityModelArgs(tokens: readonly string[]): string[] {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.startsWith('--model=')) {
      return [token]
    }
    if (token === '--model' && index + 1 < tokens.length) {
      return [token, tokens[index + 1]]
    }
  }
  return []
}
