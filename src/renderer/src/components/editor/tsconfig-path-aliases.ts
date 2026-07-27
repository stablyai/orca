import { parse as parseJsonc, type ParseError } from 'jsonc-parser'

export type TsconfigPathAliases = {
  baseUrl: string | null
  paths: Record<string, string[]>
}

export function parseTsconfigPathAliases(tsconfigText: string): TsconfigPathAliases | null {
  const errors: ParseError[] = []
  const parsed: unknown = parseJsonc(tsconfigText, errors, { allowTrailingComma: true })
  if (errors.length > 0) {
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
