const PREFIX = 'codex-provider:'

export function codexProviderModelId(provider: string, model: string): string {
  return `${PREFIX}${JSON.stringify([provider, model])}`
}

export function isCodexProviderModelId(id: string): boolean {
  return id.startsWith(PREFIX)
}

export function parseCodexModelId(id: string): { model: string; provider?: string } {
  if (!isCodexProviderModelId(id)) {
    return { model: id }
  }
  let pair: unknown
  try {
    pair = JSON.parse(id.slice(PREFIX.length))
  } catch {
    throw new Error('Invalid configured Codex model selection')
  }
  if (
    !Array.isArray(pair) ||
    pair.length !== 2 ||
    typeof pair[0] !== 'string' ||
    typeof pair[1] !== 'string' ||
    !pair[0].trim() ||
    !pair[1].trim()
  ) {
    throw new Error('Invalid configured Codex model selection')
  }
  return { provider: pair[0], model: pair[1] }
}
