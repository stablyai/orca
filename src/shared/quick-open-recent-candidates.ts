import { isWindowsAbsolutePathLike } from './cross-platform-path'
import { isClipboardTextByteLengthOverLimit } from './clipboard-text'

export const QUICK_OPEN_RECENT_CANDIDATE_LIMIT = 100
const MAX_CANDIDATE_BYTES = 64 * 1024

export function quickOpenRecentCandidateSet(paths: readonly string[]): ReadonlySet<string> {
  if (paths.length > QUICK_OPEN_RECENT_CANDIDATE_LIMIT) {
    throw new Error('Too many Quick Open recent candidates.')
  }
  const candidates = new Set<string>()
  for (const path of paths) {
    if (isClipboardTextByteLengthOverLimit(path, MAX_CANDIDATE_BYTES)) {
      throw new Error('Quick Open recent candidate path is too large.')
    }
    if (
      !path ||
      path.includes('\0') ||
      path.startsWith('/') ||
      isWindowsAbsolutePathLike(path) ||
      path.split('/').includes('..')
    ) {
      continue
    }
    candidates.add(path)
  }
  return candidates
}
