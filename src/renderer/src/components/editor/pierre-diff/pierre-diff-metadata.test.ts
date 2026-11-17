import { describe, expect, it } from 'vitest'
import { buildPierreFileDiff } from './pierre-diff-metadata'
import { getPierreDiffChangeTargets } from './pierre-diff-change-targets'

const input = {
  path: 'example.ts',
  status: 'modified',
  cacheKey: 'workspace:file:0',
  originalContent: 'one\ntwo\nthree\nfour\nfive\n',
  modifiedContent: 'one\nTWO\nthree\nFOUR\nfive\n',
  parseDiffOptions: { ignoreWhitespace: true }
}

describe('Pierre diff content identity and navigation', () => {
  it('falls back to one trimmed replacement when a large diff exceeds the line-diff budget', () => {
    const oldBlock = 'old\n'.repeat(1_100)
    const newBlock = 'new\n'.repeat(1_100)
    const diff = buildPierreFileDiff({
      ...input,
      originalContent: `prefix\n${oldBlock}inside\n${oldBlock}suffix`,
      modifiedContent: `prefix\n${newBlock}inside\n${newBlock}suffix`
    })
    expect(diff.hunks).toHaveLength(1)
    expect(diff.hunks[0].hunkContent).toEqual([
      {
        type: 'change',
        additions: 2_201,
        deletions: 2_201,
        additionLineIndex: 1,
        deletionLineIndex: 1
      }
    ])
    expect(diff.additionLines[0]).toBe('prefix\n')
    expect(diff.additionLines.at(-1)).toBe('suffix')
    expect(diff.additionLines[1_101]).toBe('inside\n')
  })

  it('reuses unchanged content but invalidates edits, external updates, and whitespace options', () => {
    const first = buildPierreFileDiff(input)
    expect(buildPierreFileDiff(input).cacheKey).toBe(first.cacheKey)
    for (const update of [
      { modifiedContent: 'new draft\n' },
      { originalContent: 'new base\n' },
      { parseDiffOptions: { ignoreWhitespace: false } },
      { path: 'another.ts' }
    ]) {
      expect(buildPierreFileDiff({ ...input, ...update }).cacheKey).not.toBe(first.cacheKey)
    }
  })

  it('does not share stale content across workspaces with the same path and generation', () => {
    const first = buildPierreFileDiff(input)
    const second = buildPierreFileDiff({ ...input, modifiedContent: 'another workspace\n' })
    expect(second.cacheKey).not.toBe(first.cacheKey)
    expect(second.additionLines.join('')).toBe('another workspace\n')
  })

  it.each(['added', 'untracked', 'deleted'])('gives %s files worker cache identities', (status) => {
    expect(buildPierreFileDiff({ ...input, status }).cacheKey).toBeTruthy()
  })

  it('navigates every change inside one context hunk', () => {
    const diff = buildPierreFileDiff(input)
    expect(diff.hunks).toHaveLength(1)
    expect(getPierreDiffChangeTargets(diff)).toEqual([
      { lineNumber: 2, side: 'additions' },
      { lineNumber: 4, side: 'additions' }
    ])
  })

  it('targets the old side for pure deletions, including deleted files', () => {
    expect(
      getPierreDiffChangeTargets(
        buildPierreFileDiff({
          ...input,
          modifiedContent: 'one\nthree\nfour\nfive\n'
        })
      )
    ).toEqual([{ lineNumber: 2, side: 'deletions' }])
    expect(
      getPierreDiffChangeTargets(buildPierreFileDiff({ ...input, status: 'deleted' }))
    ).toEqual([{ lineNumber: 1, side: 'deletions' }])
  })
})
