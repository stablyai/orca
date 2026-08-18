import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildPullRequestFieldsPrompt,
  GENERATED_PULL_REQUEST_JSON_STRUCTURE_LIMITS,
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

  it('requires ELI5 problem and solution sections before implementation details', () => {
    const prompt = buildPullRequestFieldsPrompt(context, '')

    expect(prompt).toContain('start with `## Problem`, then `## Solution`')
    expect(prompt).toContain('simple ELI5 language before details')
    expect(prompt).toContain('Reuse equivalent existing sections instead of duplicating them')
  })

  it('includes GitHub issue details and complete or partial reference guidance', () => {
    const prompt = buildPullRequestFieldsPrompt(
      {
        ...context,
        provider: 'github',
        linkedIssueDetails: {
          provider: 'github',
          number: 12398,
          title: 'Stop phantom polling',
          description: 'Helpers repeatedly stat Linux-only PATH entries.'
        }
      },
      ''
    )

    expect(prompt).toContain('Linked GitHub issue: #12398 Stop phantom polling')
    expect(prompt).toContain('Issue description:\nHelpers repeatedly stat Linux-only PATH entries.')
    expect(prompt).toContain('`Fixes #12398` only for a complete fix')
    expect(prompt).toContain('use `Refs #12398`')
  })

  it('uses GitLab-specific issue references', () => {
    const prompt = buildPullRequestFieldsPrompt(
      {
        ...context,
        provider: 'gitlab',
        linkedIssueDetails: {
          provider: 'gitlab',
          number: 42,
          title: 'Fix runner polling',
          description: 'The runner checks paths that cannot exist.'
        }
      },
      ''
    )

    expect(prompt).toContain('Linked GitLab issue: #42 Fix runner polling')
    expect(prompt).toContain('`Closes #42` only for a complete fix')
    expect(prompt).toContain('use `Related to #42`')
    expect(prompt).not.toContain('GitHub issue')
  })

  it('uses the active provider when no issue is linked', () => {
    const prompt = buildPullRequestFieldsPrompt({ ...context, provider: 'bitbucket' }, '')

    expect(prompt).toContain('Linked Bitbucket issue: (none)')
    expect(prompt).toContain('No Bitbucket issue is linked; do not invent one')
    expect(prompt).not.toContain('GitHub issue')
  })

  it('uses Azure DevOps work-item syntax', () => {
    const prompt = buildPullRequestFieldsPrompt(
      {
        ...context,
        provider: 'azure-devops',
        linkedIssueDetails: {
          provider: 'azure-devops',
          number: 99,
          title: 'Stop unnecessary polling',
          description: 'Avoid checks for unavailable tools.'
        }
      },
      ''
    )

    expect(prompt).toContain('Linked Azure DevOps issue: AB#99 Stop unnecessary polling')
    expect(prompt).toContain('`Fixes AB#99` only for a complete fix')
    expect(prompt).toContain('use `AB#99`')
  })

  it('tells the agent to preserve existing review templates', () => {
    const prompt = buildPullRequestFieldsPrompt(
      {
        ...context,
        currentBody: '## Summary\n\n## Testing\n\n- [ ] Required checks'
      },
      ''
    )

    expect(prompt).toContain('Retain every heading, required section, and checklist')
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

  it('rejects excessive nesting before JSON.parse', () => {
    const parseSpy = vi.spyOn(JSON, 'parse')
    const depth = GENERATED_PULL_REQUEST_JSON_STRUCTURE_LIMITS.nestingDepth + 1
    try {
      expect(() =>
        parseGeneratedPullRequestFields(`${'['.repeat(depth)}0${']'.repeat(depth)}`, context)
      ).toThrow(/JSON nesting exceeds/)
      expect(parseSpy).not.toHaveBeenCalled()
    } finally {
      parseSpy.mockRestore()
    }
  })
})
