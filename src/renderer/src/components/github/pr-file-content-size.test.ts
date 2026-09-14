import { describe, expect, it } from 'vitest'
import type { GitHubPRFileContents } from '../../../../shared/github/pull-request-types'
import { getPRFileContentsCacheByteCount } from './pr-file-content-size'

describe('PR file content size', () => {
  it('counts astral characters and lone surrogates as UTF-8 bytes', () => {
    const contents: GitHubPRFileContents = {
      original: '😀\ud800',
      modified: '\udc00é',
      originalIsBinary: false,
      modifiedIsBinary: false
    }

    expect(getPRFileContentsCacheByteCount(contents)).toBe(12)
  })
})
