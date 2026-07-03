import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildGitConflictDecorations,
  findGitConflictBlocks,
  getGitConflictMarkerLineLength,
  hasGitConflictMarkers
} from './monaco-conflict-decorations'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('findGitConflictBlocks', () => {
  it('finds standard conflict marker blocks', () => {
    const content = [
      'before',
      '<<<<<<< HEAD',
      'current',
      '=======',
      'incoming',
      '>>>>>>> branch',
      'after'
    ].join('\n')

    expect(findGitConflictBlocks(content)).toEqual([
      {
        startLine: 2,
        separatorLine: 4,
        endLine: 6
      }
    ])
  })

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

  it('parses CRLF conflict blocks without allocating a full line array', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const content = [
      'before',
      '<<<<<<< HEAD',
      'current',
      '=======',
      'incoming',
      '>>>>>>> branch'
    ].join('\r\n')

    expect(findGitConflictBlocks(content)).toEqual([
      {
        startLine: 2,
        separatorLine: 4,
        endLine: 6
      }
    ])
    expect(split).not.toHaveBeenCalled()
  })

  it('keeps non-ASCII line content aligned while scanning conflict markers', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const content = [
      '概要 😀',
      '<<<<<<< HEAD',
      'résumé 修正',
      '=======',
      '検索 １２３',
      '>>>>>>> branch'
    ].join('\r\n')

    expect(findGitConflictBlocks(content)).toEqual([
      {
        startLine: 2,
        separatorLine: 4,
        endLine: 6
      }
    ])
    expect(getGitConflictMarkerLineLength(content, 2)).toBe('<<<<<<< HEAD'.length)
    expect(split).not.toHaveBeenCalled()
  })
})

describe('buildGitConflictDecorations', () => {
  it('builds section and marker decorations for a conflict block', () => {
    const decorations = buildGitConflictDecorations(
      ['<<<<<<< HEAD', 'current', '=======', 'incoming', '>>>>>>> branch'].join('\n')
    )

    expect(decorations).toHaveLength(5)
    expect(decorations[0]).toMatchObject({
      range: { startLineNumber: 2, endLineNumber: 2 },
      options: { className: 'orca-conflict-section-line orca-conflict-current-line' }
    })
    expect(decorations[1]).toMatchObject({
      range: { startLineNumber: 4, endLineNumber: 4 },
      options: { className: 'orca-conflict-section-line orca-conflict-incoming-line' }
    })
    expect(decorations[2]).toMatchObject({
      range: { startLineNumber: 1, endLineNumber: 1 },
      options: {
        className: 'orca-conflict-marker-line',
        linesDecorationsClassName: 'orca-conflict-line-decoration',
        after: { content: ' Current change' }
      }
    })
  })

  it('detects incomplete markers without producing bogus ranges', () => {
    const content = ['<<<<<<< HEAD', 'current'].join('\n')

    expect(hasGitConflictMarkers(content)).toBe(true)
    expect(buildGitConflictDecorations(content)).toEqual([])
  })

  it('stops marker existence scans after the first marker line', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const charCodeAt = vi.spyOn(String.prototype, 'charCodeAt')
    const content = ['<<<<<<< HEAD', 'x'.repeat(100_000)].join('\n')

    expect(hasGitConflictMarkers(content)).toBe(true)

    expect(split).not.toHaveBeenCalled()
    expect(charCodeAt.mock.calls.length).toBeLessThan(32)
  })

  it('builds decorations for large conflict bodies without splitting the full payload', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const content = [
      '<<<<<<< HEAD',
      'current',
      '=======',
      'x'.repeat(100_000),
      '>>>>>>> branch'
    ].join('\r\n')

    const decorations = buildGitConflictDecorations(content)

    expect(decorations).toHaveLength(5)
    expect(decorations.at(-1)).toMatchObject({
      range: { startLineNumber: 5, endLineNumber: 5 },
      options: { after: { content: ' End conflict' } }
    })
    expect(split).not.toHaveBeenCalled()
  })
})

describe('getGitConflictMarkerLineLength', () => {
  it('returns marker line length for LF and CRLF content without splitting', () => {
    const split = vi.spyOn(String.prototype, 'split')

    expect(getGitConflictMarkerLineLength('before\n<<<<<<< HEAD\nafter', 2)).toBe(
      '<<<<<<< HEAD'.length
    )
    expect(getGitConflictMarkerLineLength('before\r\n>>>>>>> branch\r\nafter', 2)).toBe(
      '>>>>>>> branch'.length
    )

    expect(split).not.toHaveBeenCalled()
  })

  it('stops after the requested marker line in large pasted source', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const charCodeAt = vi.spyOn(String.prototype, 'charCodeAt')
    const content = ['before', '<<<<<<< HEAD', 'x'.repeat(100_000)].join('\n')

    expect(getGitConflictMarkerLineLength(content, 2)).toBe('<<<<<<< HEAD'.length)

    expect(split).not.toHaveBeenCalled()
    expect(charCodeAt.mock.calls.length).toBeLessThan(64)
  })

  it('returns zero for missing or invalid target lines', () => {
    expect(getGitConflictMarkerLineLength('<<<<<<< HEAD', 0)).toBe(0)
    expect(getGitConflictMarkerLineLength('<<<<<<< HEAD', 4)).toBe(0)
  })
})
