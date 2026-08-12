import { MAX_RENDERED_DIFF_COMBINED_CHARACTERS } from '@/components/editor/large-diff-render-limit'
import type { GitHubPRFile, GitHubPRFileContents } from '../../../../shared/types'
import { getUtf8ByteLength } from '../../../../shared/utf8-byte-limits'

export const PR_FILE_CONTENT_CACHE_MAX_BYTES = MAX_RENDERED_DIFF_COMBINED_CHARACTERS * 4

export function isPRFileViewed(file: GitHubPRFile): boolean {
  return file.viewerViewedState === 'VIEWED'
}

export function isPRFileContentsTooLargeSentinel(contents: GitHubPRFileContents): boolean {
  return contents.originalTooLarge === true || contents.modifiedTooLarge === true
}

export function getPRFileContentsCacheByteCount(contents: GitHubPRFileContents): number {
  if (isPRFileContentsTooLargeSentinel(contents)) {
    return 0
  }
  return getUtf8ByteLength(contents.original) + getUtf8ByteLength(contents.modified)
}

export function getRetainedPRFileContentsByteCount(contents: GitHubPRFileContents): number | null {
  if (isPRFileContentsTooLargeSentinel(contents)) {
    return 0
  }
  const byteCount = getPRFileContentsCacheByteCount(contents)
  return byteCount <= PR_FILE_CONTENT_CACHE_MAX_BYTES ? byteCount : null
}
