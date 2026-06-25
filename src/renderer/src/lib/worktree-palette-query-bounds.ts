import { isClipboardTextByteLengthOverLimit } from '../../../shared/clipboard-text'

export const WORKTREE_PALETTE_QUERY_MAX_BYTES = 2 * 1024

export function isWorktreePaletteQueryTooLarge(
  query: string,
  maxBytes = WORKTREE_PALETTE_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}
