import { MAX_RENDERED_DIFF_COMBINED_CHARACTERS } from '@/components/editor/large-diff-render-limit'
import type { GitHubPRFile, GitHubPRFileContents } from '../../../../shared/types'

export const PR_FILE_CONTENT_CACHE_MAX_BYTES = MAX_RENDERED_DIFF_COMBINED_CHARACTERS * 4

export function isPRFileViewed(file: GitHubPRFile): boolean {
  return file.viewerViewedState === 'VIEWED'
}

export function getUtf8ByteCount(value: string): number {
  let byteCount = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x80) {
      byteCount += 1
    } else if (code < 0x800) {
      byteCount += 2
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        byteCount += 4
        index += 1
      } else {
        byteCount += 3
      }
    } else {
      byteCount += 3
    }
  }
  return byteCount
}

export function isPRFileContentsTooLargeSentinel(contents: GitHubPRFileContents): boolean {
  return contents.originalTooLarge === true || contents.modifiedTooLarge === true
}

export function getPRFileContentsCacheByteCount(contents: GitHubPRFileContents): number {
  if (isPRFileContentsTooLargeSentinel(contents)) {
    return 0
  }
  return getUtf8ByteCount(contents.original) + getUtf8ByteCount(contents.modified)
}

export function getRetainedPRFileContentsByteCount(contents: GitHubPRFileContents): number | null {
  if (isPRFileContentsTooLargeSentinel(contents)) {
    return 0
  }
  const byteCount = getPRFileContentsCacheByteCount(contents)
  return byteCount <= PR_FILE_CONTENT_CACHE_MAX_BYTES ? byteCount : null
}
