import { isClipboardTextByteLengthOverLimit } from '../clipboard-text'

export const SMART_WORKSPACE_SOURCE_QUERY_MAX_BYTES = 2048

export function isSmartWorkspaceSourceQueryWithinLimit(
  query: string,
  maxBytes = SMART_WORKSPACE_SOURCE_QUERY_MAX_BYTES
): boolean {
  return !isClipboardTextByteLengthOverLimit(query, maxBytes)
}
