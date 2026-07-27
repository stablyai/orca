export type TsconfigPathAliases = {
  baseUrl: string | null
  paths: Record<string, string[]>
}

function stripJsonCommentsAndTrailingCommas(text: string): string {
  let result = ''
  let inString = false
  let inLineComment = false
  let inBlockComment = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1]
    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false
        result += char
      }
      continue
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false
        index += 1
      }
      continue
    }
    if (inString) {
      result += char
      if (char === '\\') {
        result += next ?? ''
        index += 1
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      result += char
      continue
    }
    if (char === '/' && next === '/') {
      inLineComment = true
      index += 1
      continue
    }
    if (char === '/' && next === '*') {
      inBlockComment = true
      index += 1
      continue
    }
    result += char
  }
  return result.replace(/,\s*([}\]])/g, '$1')
}

export function parseTsconfigPathAliases(tsconfigText: string): TsconfigPathAliases | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripJsonCommentsAndTrailingCommas(tsconfigText))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }
  const compilerOptions = (parsed as { compilerOptions?: unknown }).compilerOptions
  if (typeof compilerOptions !== 'object' || compilerOptions === null) {
    return null
  }
  const { baseUrl, paths } = compilerOptions as { baseUrl?: unknown; paths?: unknown }
  const aliases: TsconfigPathAliases = {
    baseUrl: typeof baseUrl === 'string' ? baseUrl : null,
    paths: {}
  }
  if (typeof paths === 'object' && paths !== null) {
    for (const [pattern, targets] of Object.entries(paths)) {
      if (Array.isArray(targets)) {
        const valid = targets.filter((target): target is string => typeof target === 'string')
        if (valid.length > 0) {
          aliases.paths[pattern] = valid
        }
      }
    }
  }
  return aliases
}
