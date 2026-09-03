import {
  getMarkdownRichModeEligibility,
  type MarkdownRichModeEligibility
} from './markdown-rich-mode'

type EligibilityCacheEntry = {
  content: string
  sizeOverridden: boolean
  result: MarkdownRichModeEligibility
}

// Why: one entry per visible markdown surface (active tab plus split panes),
// so a split view does not evict its own siblings on every render.
const MAX_ENTRIES = 4

const entries: EligibilityCacheEntry[] = []

/**
 * Memoized `getMarkdownRichModeEligibility`.
 *
 * Why: the classifier is pure but scans the whole document (and can build a
 * throwaway TipTap editor to round-trip it), while `EditorPanel` re-renders
 * from ~18 store subscriptions — including idle git-status polls. Keying on
 * the content string keeps classification at once per content change instead
 * of once per render, with byte-identical output.
 */
export function getCachedMarkdownRichModeEligibility(params: {
  content: string
  sizeOverridden: boolean
}): MarkdownRichModeEligibility {
  const { content, sizeOverridden } = params
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry.sizeOverridden !== sizeOverridden || entry.content !== content) {
      continue
    }
    if (index > 0) {
      entries.splice(index, 1)
      entries.unshift(entry)
    }
    return entry.result
  }

  const result = getMarkdownRichModeEligibility({ content, sizeOverridden })
  entries.unshift({ content, sizeOverridden, result })
  if (entries.length > MAX_ENTRIES) {
    entries.length = MAX_ENTRIES
  }
  return result
}

export function resetMarkdownRichModeEligibilityCache(): void {
  entries.length = 0
}
