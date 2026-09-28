import { describe, expect, it } from 'vitest'
import type { GitDiffResult } from '../../../../../../shared/git-diff-compare-types'
import { combineWorkingTreeDiffResult } from './working-tree-diff-result'

const text = (originalContent: string, modifiedContent: string): GitDiffResult => ({
  kind: 'text',
  originalContent,
  modifiedContent,
  originalIsBinary: false,
  modifiedIsBinary: false
})

describe('merge base to working tree content', () => {
  it('includes committed, staged and unstaged edits in one diff', () => {
    expect(
      combineWorkingTreeDiffResult(
        text('base', 'committed'),
        text('committed', 'committed + staged + unstaged')
      )
    ).toEqual({ ...text('base', 'committed + staged + unstaged'), largeDiffRenderLimit: undefined })
  })
  it('shows edits that cancel committed changes as identical content', () => {
    expect(
      combineWorkingTreeDiffResult(text('base', 'committed'), text('committed', 'base'))
    ).toMatchObject({ originalContent: 'base', modifiedContent: 'base' })
  })
  it('uses only the binary flags of the displayed sides', () => {
    const binary: GitDiffResult = {
      kind: 'binary',
      originalContent: 'binary',
      modifiedContent: 'text',
      originalIsBinary: true,
      modifiedIsBinary: false
    }
    expect(combineWorkingTreeDiffResult(text('base', 'head'), binary)).toMatchObject({
      kind: 'text',
      originalContent: 'base',
      modifiedContent: 'text'
    })
    expect(combineWorkingTreeDiffResult(binary, text('head', 'working'))).toMatchObject({
      kind: 'binary',
      originalIsBinary: true,
      modifiedIsBinary: false
    })
  })
})

it('preserves a capped host response even when the other side is binary', () => {
  const limit = {
    limited: true as const,
    reason: 'character-count' as const,
    lineCounts: null,
    characterCount: 6000001,
    limits: { maxLinesPerSide: 120000, maxCombinedCharacters: 6000000 }
  }
  const limited: GitDiffResult = {
    ...text('', ''),
    kind: 'text',
    originalIsBinary: false,
    modifiedIsBinary: false,
    largeDiffRenderLimit: limit
  }
  const binary: GitDiffResult = {
    kind: 'binary',
    originalContent: '',
    modifiedContent: 'image',
    originalIsBinary: false,
    modifiedIsBinary: true
  }
  expect(combineWorkingTreeDiffResult(limited, binary)).toEqual(limited)
})
