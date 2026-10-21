import { describe, expect, it } from 'vitest'
import { buildGitLineBlameWidgetModel } from './git-line-blame-decorations'

describe('buildGitLineBlameWidgetModel', () => {
  it('skips lines outside the model', () => {
    expect(
      buildGitLineBlameWidgetModel(
        {
          line: 9,
          commitOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          author: 'Ada',
          authorTime: 1,
          summary: 'Add'
        },
        2,
        { uncommittedLabel: 'Not Committed Yet', endColumn: 1 }
      )
    ).toBeNull()
  })

  it('places the annotation at the end of the current line', () => {
    const model = buildGitLineBlameWidgetModel(
      {
        line: 1,
        commitOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        author: 'Ada',
        authorTime: 1_700_000_000,
        summary: 'Add parser'
      },
      3,
      { uncommittedLabel: 'Not Committed Yet', nowMs: 1_700_000_000 * 1000, endColumn: 12 }
    )
    expect(model).toMatchObject({
      lineNumber: 1,
      column: 12,
      text: expect.stringContaining('Ada')
    })
    expect(model?.text).toContain('Add parser')
  })
})
