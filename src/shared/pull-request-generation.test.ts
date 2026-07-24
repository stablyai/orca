import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildPullRequestFieldsPrompt,
  parseGeneratedPullRequestFields,
  type PullRequestDraftContext
} from './pull-request-generation'

const context: PullRequestDraftContext = {
  branch: 'feature/pr-details',
  base: 'main',
  branchChangedByPreparation: false,
  currentTitle: 'Feature pr details',
  currentBody: '- Add form',
  currentDraft: false,
  commitSummary: '- feat: add generated PR details',
  changeSummary: 'M\tsrc/file.ts',
  patch: 'diff --git a/src/file.ts b/src/file.ts\n+export const value = true'
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('buildPullRequestFieldsPrompt', () => {
  it('asks for compact JSON and includes PR context', () => {
    const prompt = buildPullRequestFieldsPrompt(context, 'Use conventional PR titles.')

    expect(prompt).toContain('Return ONLY compact JSON')
    expect(prompt).toContain('Head branch: feature/pr-details')
    expect(prompt).toContain('Current base: main')
    expect(prompt).toContain('Additional user prompt:')
    expect(prompt).toContain('Use conventional PR titles.')
  })

  it('tells the agent to preserve existing review templates', () => {
    const prompt = buildPullRequestFieldsPrompt(
      {
        ...context,
        currentBody: '## Summary\n\n## Testing\n\n- [ ] Required checks'
      },
      ''
    )

    expect(prompt).toContain('preserve its headings, required sections, and checklists')
    expect(prompt).toContain('Leave genuinely unknown template items as TODO or unchecked')
  })
})

describe('parseGeneratedPullRequestFields', () => {
  it('parses fenced JSON output', () => {
    const fields = parseGeneratedPullRequestFields(
      '```json\n{"base":"main","title":"fix: add details.","body":"Summary","draft":true}\n```',
      context
    )

    expect(fields).toEqual({
      base: 'main',
      title: 'fix: add details',
      body: 'Summary',
      draft: true
    })
  })

  it('parses CRLF fenced JSON output without full-string fence matching', () => {
    const matchSpy = vi.spyOn(String.prototype, 'match')
    const replaceSpy = vi.spyOn(String.prototype, 'replace')
    const fields = parseGeneratedPullRequestFields(
      '```JSON\r\n{"base":"main","title":"fix: add details.","body":"Summary","draft":true}\r\n```',
      context
    )

    expect(fields.title).toBe('fix: add details')
    const usedFenceMatch = matchSpy.mock.calls.some(
      ([pattern]) =>
        pattern instanceof RegExp &&
        pattern.source.startsWith('^```') &&
        pattern.source.includes('[\\s\\S]')
    )
    const usedCrlfReplace = replaceSpy.mock.calls.some(
      ([pattern]) => pattern instanceof RegExp && pattern.source === '\\r\\n' && pattern.global
    )
    expect(usedFenceMatch).toBe(false)
    expect(usedCrlfReplace).toBe(false)
  })

  it('falls back for missing optional values', () => {
    const fields = parseGeneratedPullRequestFields('{"title":""}', context)

    expect(fields).toEqual({
      base: 'main',
      title: 'Feature pr details',
      body: '- Add form',
      draft: false
    })
  })
})
