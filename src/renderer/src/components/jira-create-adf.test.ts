import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildJiraCreateTextAdf } from './jira-create-adf'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('buildJiraCreateTextAdf', () => {
  it('converts plain and empty lines to Jira ADF paragraphs', () => {
    expect(buildJiraCreateTextAdf('one\n\ntwo')).toEqual({
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
        { type: 'paragraph', content: [] },
        { type: 'paragraph', content: [{ type: 'text', text: 'two' }] }
      ]
    })
  })

  it('normalizes CRLF line boundaries and preserves trailing blank paragraphs', () => {
    expect(buildJiraCreateTextAdf('one\r\ntwo\r\n')).toEqual({
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'two' }] },
        { type: 'paragraph', content: [] }
      ]
    })
  })

  it('builds newline-heavy ADF without splitting the full textarea value', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const text = Array.from({ length: 5_000 }, (_, index) => `line ${index + 1}`).join('\n')

    const adf = buildJiraCreateTextAdf(text)

    expect(adf.content).toHaveLength(5_000)
    expect(adf.content[0]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'line 1' }]
    })
    expect(adf.content.at(-1)).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'line 5000' }]
    })
    expect(split).not.toHaveBeenCalled()
  })
})
