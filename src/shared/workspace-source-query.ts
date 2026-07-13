import { isClipboardTextByteLengthOverLimit } from './clipboard-text'

// Why: bound provider/ref fanout before dispatch while still allowing long,
// intentional search text across desktop and mobile clients.
export const WORKSPACE_SOURCE_QUERY_MAX_BYTES = 2048

export function isWorkspaceSourceQueryWithinLimit(
  query: string,
  maxBytes = WORKSPACE_SOURCE_QUERY_MAX_BYTES
): boolean {
  return !isClipboardTextByteLengthOverLimit(query, maxBytes)
}
