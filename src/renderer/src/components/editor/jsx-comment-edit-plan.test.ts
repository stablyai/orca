import { describe, expect, it } from 'vitest'
import type { ISelection } from 'monaco-editor'
import { buildJsxCommentEditPlan } from './jsx-comment-edit-plan'

function selection(
  startLineNumber: number,
  startColumn: number,
  endLineNumber = startLineNumber,
  endColumn = startColumn
): ISelection {
  return {
    selectionStartLineNumber: startLineNumber,
    selectionStartColumn: startColumn,
    positionLineNumber: endLineNumber,
    positionColumn: endColumn
  }
}

const OPTIONS = { insertSpace: true }

describe('JSX comment edit plan', () => {
  it('wraps multiple JSX child lines and restores the original text on the next toggle', () => {
    const source = [
      'const view = (',
      '  <section>',
      '    <h1>Hello</h1>',
      '    <p>World</p>',
      '  </section>',
      ')'
    ].join('\n')
    const selectedLines = selection(3, 1, 4, 17)
    const added = buildJsxCommentEditPlan(source, [selectedLines], OPTIONS)
    if (!added) {
      throw new Error('Expected a JSX comment edit plan')
    }

    expect(added.finalSource).toContain('    {/* <h1>Hello</h1>\n    <p>World</p> */}')
    const removed = buildJsxCommentEditPlan(added.finalSource, added.selections, OPTIONS)
    expect(removed?.finalSource).toBe(source)
  })

  it('wraps separate JSX selections in one edit set', () => {
    const source = [
      'const view = (',
      '  <section>',
      '    <h1>Hello</h1>',
      '    <p>World</p>',
      '  </section>',
      ')'
    ].join('\n')
    const plan = buildJsxCommentEditPlan(source, [selection(3, 5), selection(4, 5)], OPTIONS)

    expect(plan?.finalSource).toContain('    {/* <h1>Hello</h1> */}')
    expect(plan?.finalSource).toContain('    {/* <p>World</p> */}')
    expect(plan?.edits).toHaveLength(4)
  })

  it('preserves CRLF and a selection ending at the next line start', () => {
    const source = 'const view = (\r\n  <section>\r\n    <p>Hello</p>\r\n  </section>\r\n)'
    const plan = buildJsxCommentEditPlan(source, [selection(3, 1, 4, 1)], OPTIONS)

    expect(plan?.finalSource).toContain('    {/* <p>Hello</p> */}\r\n  </section>')
  })

  it('round-trips a multiline selection ending at the following line start', () => {
    const source = [
      'const view = (',
      '  <section>',
      '    <h1>Hello</h1>',
      '    <p>World</p>',
      '  </section>',
      ')'
    ].join('\n')
    const originalSelection = selection(3, 1, 5, 1)
    const added = buildJsxCommentEditPlan(source, [originalSelection], OPTIONS)
    if (!added) {
      throw new Error('Expected a JSX comment edit plan')
    }

    expect(added.selections[0]).toMatchObject({ positionLineNumber: 5, positionColumn: 1 })
    const removed = buildJsxCommentEditPlan(added.finalSource, added.selections, OPTIONS)
    expect(removed?.finalSource).toBe(source)
    expect(removed?.selections).toEqual([originalSelection])
  })

  it('places the cursor between comment tokens on an empty JSX child line', () => {
    const source = 'const view = <section>\n  \n</section>'
    const plan = buildJsxCommentEditPlan(source, [selection(2, 3)], OPTIONS)

    expect(plan?.edits).toHaveLength(1)
    expect(plan?.finalSource).toBe('const view = <section>\n  {/*  */}\n</section>')
    expect(plan?.selections).toEqual([
      {
        selectionStartLineNumber: 2,
        selectionStartColumn: 7,
        positionLineNumber: 2,
        positionColumn: 7
      }
    ])
  })

  it('honors the Monaco insert-space option for non-empty JSX lines', () => {
    const source = 'const view = <section>\n  <p>Hello</p>\n</section>'
    const plan = buildJsxCommentEditPlan(source, [selection(2, 3)], { insertSpace: false })

    expect(plan?.finalSource).toBe('const view = <section>\n  {/*<p>Hello</p>*/}\n</section>')
  })

  it('removes a JSX comment without consuming following JSX', () => {
    const source = 'const view = <section>\n  {/* one */} <Child />\n</section>'
    const plan = buildJsxCommentEditPlan(source, [selection(2, 3)], OPTIONS)

    expect(plan?.finalSource).toBe('const view = <section>\n  one <Child />\n</section>')
  })

  it('does not remove an adjacent comment when the cursor is in following JSX', () => {
    const source = 'const view = <section>\n  {/* one */} <Child />\n</section>'
    const plan = buildJsxCommentEditPlan(source, [selection(2, 16)], OPTIONS)

    expect(plan?.edits).toEqual([])
    expect(plan?.finalSource).toBe(source)
  })

  it('removes only the JSX comment at each cursor on a line', () => {
    const source = 'const view = <section>\n  {/* one */} {/* two */}\n</section>'
    const first = buildJsxCommentEditPlan(source, [selection(2, 3)], OPTIONS)
    const second = buildJsxCommentEditPlan(source, [selection(2, 17)], OPTIONS)

    expect(first?.finalSource).toBe('const view = <section>\n  one {/* two */}\n</section>')
    expect(second?.finalSource).toBe('const view = <section>\n  {/* one */} two\n</section>')
  })

  it('does not combine tokens from separate JSX comments', () => {
    const source = 'const view = <section>\n  {/* one */} {/* two */}\n</section>'
    const plan = buildJsxCommentEditPlan(source, [selection(2, 7, 2, 22)], OPTIONS)

    expect(plan?.edits).toEqual([])
    expect(plan?.finalSource).toBe(source)
  })

  it('rejects overlapping JSX selections', () => {
    const source = [
      'const view = (',
      '  <section>',
      '    <h1>Hello</h1>',
      '    <p>World</p>',
      '  </section>',
      ')'
    ].join('\n')
    const plan = buildJsxCommentEditPlan(source, [selection(3, 1, 4, 20), selection(4, 1)], OPTIONS)

    expect(plan).toBeNull()
  })
})
