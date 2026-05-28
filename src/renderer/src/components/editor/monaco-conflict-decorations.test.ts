import { describe, expect, it } from 'vitest'
import {
  buildGitConflictDecorations,
  findGitConflictBlocks,
  hasGitConflictMarkers
} from './monaco-conflict-decorations'

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
})
