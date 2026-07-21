const ADAL_HEADLESS_QUERY_FLAGS = new Set(['--query', '-q'])

function optionName(token: string): string {
  const eq = token.indexOf('=')
  return eq === -1 ? token : token.slice(0, eq)
}

function isAdaLHeadlessQueryFlag(token: string): boolean {
  const name = optionName(token)
  return ADAL_HEADLESS_QUERY_FLAGS.has(name) || /^-q[^-]/.test(name)
}

export function isAdaLHeadlessOneShotCommand(tokens: readonly string[]): boolean {
  return tokens.slice(1).some(isAdaLHeadlessQueryFlag)
}
