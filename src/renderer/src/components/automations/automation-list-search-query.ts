import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard-text'

/** Pasted queries above this are rejected so filtering never runs on unbounded input. */
export const AUTOMATION_LIST_SEARCH_QUERY_MAX_BYTES = 2 * 1024

export type AutomationListSearchQueryResolution =
  | { status: 'inactive' }
  | { status: 'too_large' }
  | { status: 'active'; query: string }

export function isAutomationListSearchQueryTooLarge(
  rawQuery: string,
  maxBytes = AUTOMATION_LIST_SEARCH_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(rawQuery, maxBytes)
}

/** Keep at most maxBytes+1 code units for the byte-limit check; discard the rest before storing a multi-MB paste. */
export function clampAutomationListSearchQueryInput(
  rawQuery: string,
  maxBytes = AUTOMATION_LIST_SEARCH_QUERY_MAX_BYTES
): string {
  const maxStoredCodeUnits = maxBytes + 1
  if (rawQuery.length <= maxStoredCodeUnits) {
    return rawQuery
  }
  return rawQuery.slice(0, maxStoredCodeUnits)
}

export function resolveAutomationListSearchQuery(
  rawQuery: string,
  maxBytes = AUTOMATION_LIST_SEARCH_QUERY_MAX_BYTES
): AutomationListSearchQueryResolution {
  // Why: length pre-check short-circuits multi-MB pastes before UTF-8 scan.
  if (isClipboardTextByteLengthOverLimit(rawQuery, maxBytes)) {
    return { status: 'too_large' }
  }
  const query = rawQuery.trim().toLowerCase()
  if (!query) {
    return { status: 'inactive' }
  }
  return { status: 'active', query }
}

/** Active lowercase query, or null when search must not run. */
export function getActiveAutomationListSearchQuery(
  rawQuery: string,
  maxBytes = AUTOMATION_LIST_SEARCH_QUERY_MAX_BYTES
): string | null {
  const resolved = resolveAutomationListSearchQuery(rawQuery, maxBytes)
  return resolved.status === 'active' ? resolved.query : null
}
