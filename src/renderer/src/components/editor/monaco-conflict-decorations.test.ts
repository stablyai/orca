import { afterEach, describe, expect, it, vi } from 'vitest'
import { findGitConflictBlocks } from './monaco-conflict-decorations'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('findGitConflictBlocks', () => {
  it('keeps common ancestor markers inside diff3 conflict blocks', () => {
    const content = [
      '<<<<<<< HEAD',
      'current',
      '||||||| parent of branch',
      'base',
      '=======',
      'incoming',
      '>>>>>>> branch'
    ].join('\n')

    expect(findGitConflictBlocks(content)).toEqual([
      {
        startLine: 1,
        baseLine: 3,
        separatorLine: 5,
        endLine: 7
      }
    ])
  })
})
