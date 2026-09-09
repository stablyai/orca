import {
  getMarkdownRichModeEligibilityDecision,
  resolveMarkdownRichModeUnsupportedMessage,
  type MarkdownRichModeEligibility,
  type MarkdownRichModeEligibilityDecision
} from './markdown-rich-mode'

type EligibilityCacheEntry = {
  content: string
  sizeOverridden: boolean
  decision: MarkdownRichModeEligibilityDecision
}

// Why: one entry per visible markdown surface (active tab plus split panes),
// so a split view does not evict its own siblings on every render.
const MAX_ENTRIES = 4

const entries: EligibilityCacheEntry[] = []

/**
 * Memoized rich-mode eligibility.
 *
 * Why: classifying is pure but scans the whole document (and can build a
 * throwaway TipTap editor to round-trip it), while `EditorPanel` re-renders
 * from ~18 store subscriptions — including idle git-status polls. Keying on the
 * content string keeps classification at once per content change instead of
 * once per render.
 *
 * Only the *decision* is cached. `unsupportedMessage` is resolved per read
 * because the matcher messages are late-bound `translate()` getters: caching
 * the string would freeze the fallback banner in whatever UI language happened
 * to be active when the document was first classified, which is wrong both on
 * a language switch and at startup (the persisted language is applied from an
 * effect, after the first render).
 */
export function getCachedMarkdownRichModeEligibility(params: {
  content: string
  sizeOverridden: boolean
}): MarkdownRichModeEligibility {
  const decision = getCachedMarkdownRichModeEligibilityDecision(params)
  return {
    exceedsSizeLimit: decision.exceedsSizeLimit,
    unsupportedMessage: resolveMarkdownRichModeUnsupportedMessage(decision.unsupportedReason)
  }
}

function getCachedMarkdownRichModeEligibilityDecision(params: {
  content: string
  sizeOverridden: boolean
}): MarkdownRichModeEligibilityDecision {
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
    return entry.decision
  }

  const decision = getMarkdownRichModeEligibilityDecision({ content, sizeOverridden })
  entries.unshift({ content, sizeOverridden, decision })
  if (entries.length > MAX_ENTRIES) {
    entries.length = MAX_ENTRIES
  }
  return decision
}

export function resetMarkdownRichModeEligibilityCache(): void {
  entries.length = 0
}
