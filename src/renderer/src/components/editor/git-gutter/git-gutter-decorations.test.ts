import { describe, expect, it } from 'vitest'
import { buildGitGutterDecorations } from './git-gutter-decorations'

describe('buildGitGutterDecorations', () => {
  it('returns nothing for no hunks', () => {
    expect(buildGitGutterDecorations([])).toEqual([])
  })

  it('spans added lines as a whole-line decoration', () => {
    expect(buildGitGutterDecorations([{ kind: 'added', startLine: 3, endLine: 5 }])).toEqual([
      {
        range: { startLineNumber: 3, startColumn: 1, endLineNumber: 5, endColumn: 1 },
        options: {
          isWholeLine: true,
          linesDecorationsClassName: 'orca-git-gutter orca-git-gutter-added'
        }
      }
    ])
  })

  it('uses the modified class for modified hunks', () => {
    const [decoration] = buildGitGutterDecorations([{ kind: 'modified', startLine: 2, endLine: 2 }])
    expect(decoration?.options.linesDecorationsClassName).toBe(
      'orca-git-gutter orca-git-gutter-modified'
    )
  })

  it('anchors a deletion to the line above it', () => {
    expect(buildGitGutterDecorations([{ kind: 'deleted', afterLine: 4 }])).toEqual([
      {
        range: { startLineNumber: 4, startColumn: 1, endLineNumber: 4, endColumn: 1 },
        options: {
          isWholeLine: true,
          linesDecorationsClassName: 'orca-git-gutter orca-git-gutter-deleted'
        }
      }
    ])
  })

  it('anchors a deletion above line 1 to line 1 with the top variant', () => {
    expect(buildGitGutterDecorations([{ kind: 'deleted', afterLine: 0 }])).toEqual([
      {
        range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
        options: {
          isWholeLine: true,
          linesDecorationsClassName:
            'orca-git-gutter orca-git-gutter-deleted orca-git-gutter-deleted-top'
        }
      }
    ])
  })

  it('keeps hunk order', () => {
    const decorations = buildGitGutterDecorations([
      { kind: 'added', startLine: 1, endLine: 1 },
      { kind: 'deleted', afterLine: 3 },
      { kind: 'modified', startLine: 7, endLine: 8 }
    ])
    expect(decorations.map((d) => d.range.startLineNumber)).toEqual([1, 3, 7])
  })

  it('anchors a negative deletion boundary above line 1 like afterLine 0', () => {
    expect(buildGitGutterDecorations([{ kind: 'deleted', afterLine: -3 }])).toEqual(
      buildGitGutterDecorations([{ kind: 'deleted', afterLine: 0 }])
    )
  })

  it('drops hunks whose range is inverted', () => {
    expect(buildGitGutterDecorations([{ kind: 'added', startLine: 5, endLine: 3 }])).toEqual([])
  })

  it('drops hunks with non-positive line numbers', () => {
    expect(buildGitGutterDecorations([{ kind: 'modified', startLine: 0, endLine: 2 }])).toEqual([])
  })

  it('keeps valid hunks when dropping an invalid neighbour', () => {
    const decorations = buildGitGutterDecorations([
      { kind: 'added', startLine: 5, endLine: 3 },
      { kind: 'added', startLine: 7, endLine: 8 }
    ])
    expect(decorations.map((d) => d.range.startLineNumber)).toEqual([7])
  })
})
