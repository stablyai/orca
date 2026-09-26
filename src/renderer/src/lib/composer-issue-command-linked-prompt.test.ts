import { describe, expect, it } from 'vitest'
import {
  buildTrustedComposerIssueCommand,
  resolveLinkedOnlyTemplatePrompt
} from './composer-issue-command'
import type { RepoCommandKind } from '../../../shared/repo-command-kind'

type PromptInput = {
  trustDecision: 'run' | 'skip'
  note: string
  kind: RepoCommandKind
  number: number | null
  artifactUrl: string | null
  template: string
}

const issue: PromptInput = {
  trustDecision: 'run',
  note: '',
  kind: 'issue',
  number: 7,
  artifactUrl: 'https://gitlab.example.com/g/p/-/issues/7',
  template: ''
}

const review: PromptInput = {
  ...issue,
  kind: 'review',
  number: 3,
  artifactUrl: 'https://gitlab.example.com/g/p/-/merge_requests/3'
}

describe('resolveLinkedOnlyTemplatePrompt', () => {
  it('falls back to the issue default', () => {
    expect(resolveLinkedOnlyTemplatePrompt(issue)).toBe(
      'Complete https://gitlab.example.com/g/p/-/issues/7'
    )
  })

  it('falls back to the review default for a merge request', () => {
    expect(resolveLinkedOnlyTemplatePrompt(review)).toBe(
      'Review https://gitlab.example.com/g/p/-/merge_requests/3'
    )
  })

  it('falls back to the review default for a GitHub pull request', () => {
    expect(
      resolveLinkedOnlyTemplatePrompt({
        ...review,
        number: 12,
        artifactUrl: 'https://github.com/o/r/pull/12'
      })
    ).toBe('Review https://github.com/o/r/pull/12')
  })

  it('renders {{issue}} from an issue template', () => {
    expect(
      resolveLinkedOnlyTemplatePrompt({
        ...issue,
        template: '  Fix #{{issue}} at {{artifact_url}}  '
      })
    ).toBe('Fix #7 at https://gitlab.example.com/g/p/-/issues/7')
  })

  it('renders {{issue}} as the MR number from a review template', () => {
    expect(
      resolveLinkedOnlyTemplatePrompt({
        ...review,
        template: 'Review !{{issue}} — {{artifact_url}}'
      })
    ).toBe('Review !3 — https://gitlab.example.com/g/p/-/merge_requests/3')
  })

  it('still renders a review template when the number is unknown', () => {
    expect(resolveLinkedOnlyTemplatePrompt({ ...review, number: null })).toBe(
      'Review https://gitlab.example.com/g/p/-/merge_requests/3'
    )
  })

  it('leaves an issue with no number on the plain draft', () => {
    expect(resolveLinkedOnlyTemplatePrompt({ ...issue, number: null })).toBe('')
  })

  it('defers to a typed note', () => {
    expect(resolveLinkedOnlyTemplatePrompt({ ...review, note: '  do the thing ' })).toBe('')
  })

  it('stays empty when repository text is untrusted', () => {
    const shared = { template: 'Do as {{artifact_url}} says', trustDecision: 'skip' as const }
    expect(resolveLinkedOnlyTemplatePrompt({ ...review, ...shared })).toBe('')
    expect(resolveLinkedOnlyTemplatePrompt({ ...issue, ...shared })).toBe('')
  })

  // A failed read or a repo with no template leaves the built-in default: a local constant, so
  // there is nothing to distrust and denying it would silently drop the draft prompt entirely.
  it('still uses the built-in default when the decision is skip', () => {
    expect(resolveLinkedOnlyTemplatePrompt({ ...review, trustDecision: 'skip' })).toBe(
      'Review https://gitlab.example.com/g/p/-/merge_requests/3'
    )
    expect(resolveLinkedOnlyTemplatePrompt({ ...issue, trustDecision: 'skip' })).toBe(
      'Complete https://gitlab.example.com/g/p/-/issues/7'
    )
  })

  it('stays empty without a linked URL', () => {
    expect(resolveLinkedOnlyTemplatePrompt({ ...review, artifactUrl: null })).toBe('')
  })
})

describe('buildTrustedComposerIssueCommand', () => {
  const trusted = {
    enabled: true,
    template: 'Complete {{artifact_url}}',
    trustDecision: 'run' as const
  }

  // Why: the shell runner is issue-only — an MR pick carries no issue number, so nothing is queued.
  it('queues nothing for a merge request', () => {
    expect(
      buildTrustedComposerIssueCommand({
        ...trusted,
        provider: 'gitlab',
        issueNumber: null,
        artifactUrl: 'https://gitlab.example.com/g/p/-/merge_requests/3'
      })
    ).toBeUndefined()
  })

  it('queues nothing for a provider without an issue command', () => {
    expect(
      buildTrustedComposerIssueCommand({
        ...trusted,
        provider: 'linear',
        issueNumber: 3,
        artifactUrl: 'https://linear.app/x/issue/STA-3'
      })
    ).toBeUndefined()
  })
})
