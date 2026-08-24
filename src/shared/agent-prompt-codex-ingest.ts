import { sanitizeAgentPromptText } from './agent-prompt-injection'

export const CODEX_LARGE_PASTE_CHAR_THRESHOLD = 1_000

export type CodexPasteMarkerMultiset = ReadonlyMap<string, number>

export type CodexPasteMarkerDelta = Readonly<{
  marker: string
  visibleCount: number
}>

export function codexAgentPromptCharCount(prompt: string): number {
  const normalized = sanitizeAgentPromptText(prompt).replace(/\r\n|\r/g, '\n')
  let count = 0
  for (const character of normalized) {
    const codePoint = character.codePointAt(0)!
    if (character !== '\n' && character !== '\t' && isUnicodeControl(codePoint)) {
      continue
    }
    count += 1
  }
  return count
}

export function collectCodexPasteMarkers(
  lines: readonly string[],
  charCount: number
): Map<string, number> {
  const markers = new Map<string, number>()
  const pattern = new RegExp(`\\[Pasted Content ${charCount} chars\\](?: #[1-9]\\d*)?`, 'g')
  for (const marker of lines.join('').matchAll(pattern)) {
    const value = marker[0]
    markers.set(value, (markers.get(value) ?? 0) + 1)
  }
  return markers
}

export function findCodexPasteMarkerDelta(
  baseline: CodexPasteMarkerMultiset,
  current: CodexPasteMarkerMultiset
): CodexPasteMarkerDelta | null {
  let delta: CodexPasteMarkerDelta | null = null
  for (const [marker, baselineCount] of baseline) {
    if ((current.get(marker) ?? 0) < baselineCount) {
      return null
    }
  }
  for (const [marker, currentCount] of current) {
    const increment = currentCount - (baseline.get(marker) ?? 0)
    if (increment === 0) {
      continue
    }
    if (increment !== 1 || delta) {
      return null
    }
    delta = { marker, visibleCount: currentCount }
  }
  return delta
}

export function countCodexPasteMarker(lines: readonly string[], marker: string): number {
  let count = 0
  const visibleText = lines.join('')
  let cursor = 0
  while (cursor <= visibleText.length - marker.length) {
    const match = visibleText.indexOf(marker, cursor)
    if (match === -1) {
      break
    }
    count += 1
    cursor = match + marker.length
  }
  return count
}

function isUnicodeControl(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
}
