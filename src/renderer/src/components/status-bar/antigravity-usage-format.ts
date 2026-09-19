import type { RateLimitWindow } from '../../../../shared/rate-limit-types'

export function getAntigravityGroupShortLabel(groupName?: string): string {
  if (!groupName) {
    return 'Other'
  }
  if (/^gemini/i.test(groupName)) {
    return 'G'
  }
  if (/claude|gpt/i.test(groupName)) {
    return 'C/G'
  }
  return groupName
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 3)
    .toUpperCase()
}

export function sortAntigravityBuckets<
  T extends Pick<RateLimitWindow, 'windowMinutes'> & { name?: string }
>(buckets: T[]): T[] {
  return buckets.slice().sort((a, b) => {
    const aKnown = a.windowMinutes > 0
    const bKnown = b.windowMinutes > 0
    if (aKnown !== bKnown) {
      return aKnown ? -1 : 1
    }
    return a.windowMinutes - b.windowMinutes || (a.name ?? '').localeCompare(b.name ?? '')
  })
}
