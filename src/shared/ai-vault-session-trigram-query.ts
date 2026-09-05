export const AI_VAULT_FTS_TRIGRAM_MIN_CHARS = 3

export function splitAiVaultFtsQuerySegments(query: string): string[] {
  return query
    .split(/\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
}

export function aiVaultFtsQueryIsDegraded(segments: readonly string[]): boolean {
  return segments.some((segment) => [...segment].length < AI_VAULT_FTS_TRIGRAM_MIN_CHARS)
}

export function buildAiVaultFtsMatchExpression(segments: readonly string[]): string {
  return segments.map((segment) => `"${segment.replaceAll('"', '""')}"`).join(' AND ')
}

export function escapeAiVaultFtsLike(segment: string): string {
  return segment.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

export function makeAiVaultLikeSnippet(text: string, firstSegment: string): string {
  const lower = text.toLowerCase()
  const needle = firstSegment.toLowerCase()
  const byteIndex = lower.indexOf(needle)
  if (byteIndex === -1) {
    return Array.from(text).slice(0, 120).join('')
  }
  const chars = Array.from(text)
  const charIndex = Array.from(text.slice(0, byteIndex)).length
  const segmentLength = Array.from(firstSegment).length
  const start = Math.max(0, charIndex - 40)
  const end = Math.min(chars.length, charIndex + segmentLength + 80)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < chars.length ? '…' : ''
  return `${prefix}${chars.slice(start, end).join('')}${suffix}`
}

export function aiVaultFtsRolesForScope(
  searchScope: 'full' | 'fullWithoutTools' | 'user' | 'assistant' | 'errors'
): readonly string[] | null {
  switch (searchScope) {
    case 'full':
      // Why: tools stay in a role column so Full text can still match them, but
      // Without tools / User / Assistant never see raw tool payloads.
      return null
    case 'fullWithoutTools':
      return ['user', 'assistant']
    case 'user':
      return ['user']
    case 'assistant':
      return ['assistant']
    case 'errors':
      return ['error']
  }
}
