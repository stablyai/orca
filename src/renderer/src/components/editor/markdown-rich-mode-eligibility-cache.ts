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

// Retain split-pane siblings so visible surfaces do not evict each other on every render.
const MAX_ENTRIES = 4

const entries: EligibilityCacheEntry[] = []

/** Cache whole-document classification by content across rerenders; resolve messages per read so language changes stay current. */
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
