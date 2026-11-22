import { describe, expect, it } from 'vitest'
import { agentMessagePreviewLine } from './agent-message-preview-line'

describe('agentMessagePreviewLine', () => {
  it('shows a one-line plain message whole, with nothing more to open', () => {
    expect(agentMessagePreviewLine('  Rebased on main, checks running again.\n')).toEqual({
      line: 'Rebased on main, checks running again.',
      more: false
    })
  })

  it('takes the first line with words and says there is more below it', () => {
    expect(
      agentMessagePreviewLine('\n\nPR #46174 is ready.\n\nMerge pending your go-ahead.')
    ).toEqual({ line: 'PR #46174 is ready.', more: true })
  })

  it('drops Markdown marks but keeps link words, and counts the dropped marks as more', () => {
    expect(
      agentMessagePreviewLine('## Done: **all** `tests` pass, see [the PR](https://x.test/1)')
    ).toEqual({ line: 'Done: all tests pass, see the PR', more: true })
  })

  it('drops single emphasis and keeps a link whose address holds parentheses', () => {
    expect(agentMessagePreviewLine('*Done*, all green')).toEqual({
      line: 'Done, all green',
      more: true
    })
    expect(agentMessagePreviewLine('***Done***').line).toBe('Done')
    expect(agentMessagePreviewLine('See [PR](https://x.test/(a)b) now').line).toBe('See PR now')
    expect(agentMessagePreviewLine('5 * 3 is 15')).toEqual({ line: '5 * 3 is 15', more: false })
  })

  it('keeps the stars of globs, dropping only marks paired around words', () => {
    expect(agentMessagePreviewLine('Lint src/**/*.ts and **/*.js, then *.ts,*.js').line).toBe(
      'Lint src/**/*.ts and **/*.js, then *.ts,*.js'
    )
  })

  it('keeps underscores inside names such as term_0', () => {
    expect(agentMessagePreviewLine('Reply to term_0 when done').line).toBe(
      'Reply to term_0 when done'
    )
  })

  it('skips code fences and lines with no words', () => {
    expect(agentMessagePreviewLine('```sh\npnpm test\n```\n---\n- Tests pass')).toEqual({
      line: 'Tests pass',
      more: true
    })
  })

  it('has no line for an empty or code-only message', () => {
    expect(agentMessagePreviewLine('')).toEqual({ line: '', more: false })
    expect(agentMessagePreviewLine('```\nx = 1\n```')).toEqual({
      line: '',
      more: true
    })
  })

  it('cuts a very long line on a code-point boundary', () => {
    const { line, more } = agentMessagePreviewLine(`${'a'.repeat(199)}😀 tail`)
    expect(line).toBe(`${'a'.repeat(199)}…`)
    expect(more).toBe(true)
  })
})
