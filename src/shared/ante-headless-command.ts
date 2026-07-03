const ANTE_HEADLESS_PROMPT_FLAGS = new Set(['--prompt', '-p'])

function optionName(token: string): string {
  const eq = token.indexOf('=')
  return eq === -1 ? token : token.slice(0, eq)
}

function isAnteHeadlessPromptFlag(token: string): boolean {
  const name = optionName(token)
  return ANTE_HEADLESS_PROMPT_FLAGS.has(name) || /^-p[^-]/.test(name)
}

export function isAnteHeadlessOneShotCommand(tokens: readonly string[]): boolean {
  for (let index = 1; index < tokens.length; index += 1) {
    if (isAnteHeadlessPromptFlag(tokens[index])) {
      return true
    }
  }
  return false
}
