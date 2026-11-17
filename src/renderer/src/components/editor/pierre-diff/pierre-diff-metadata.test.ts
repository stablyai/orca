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
  it('keeps separate change hunks in an ordinary 2,000-line replacement diff', () => {
    const original = Array.from({ length: 24_000 }, (_, index) => `line ${index}\n`)
    const modified = original.map((line, index) => (index % 12 === 0 ? `changed ${index}\n` : line))
    const diff = buildPierreFileDiff({
      ...input,
      originalContent: original.join(''),
      modifiedContent: modified.join('')
    })
    expect(diff.hunks).toHaveLength(2_000)
    expect(diff.hunks[1].hunkContent.find((content) => content.type === 'change')).toEqual({
      type: 'change',
      additions: 1,
      deletions: 1,
      additionLineIndex: 12,
      deletionLineIndex: 12
    })
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
