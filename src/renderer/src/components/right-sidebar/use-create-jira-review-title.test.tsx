// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useCreatePullRequestDialogFields } from './useCreatePullRequestDialogFields'
import type { HostedReviewCreationEligibility } from '../../../../shared/hosted-review'
import type { WorkspaceAttachmentMetadata } from '../../../../shared/workspace-attachment-legacy'

const workspace: WorkspaceAttachmentMetadata = {
  linkedWorkItem: {
    provider: 'jira',
    type: 'issue',
    number: 0,
    jiraIdentifier: 'team_alpha9-7',
    title: 'Restore login',
    url: 'https://jira.example.com/jira/browse/team_alpha9-7'
  }
}
const fields = {
  base: 'main',
  title: 'team_alpha9-7 TEAM_ALPHA9-7 Restore login',
  body: 'Generated body',
  draft: false
}
const revisions = { base: 0, title: 0, body: 0, draft: 0 }

function options(provider: 'github' | 'gitlab') {
  const eligibility: HostedReviewCreationEligibility = {
    provider,
    review: null,
    canCreate: true,
    blockedReason: null,
    nextAction: null,
    reviewLookupOutcome: 'not_found',
    defaultBaseRef: 'main',
    title: 'Restore login',
    body: 'Details'
  }
  return {
    open: true,
    repoId: 'repo-1',
    worktreeId: 'wt-1',
    worktreePath: '/repo/wt',
    branch: 'user/team_alpha9-7-restore-login',
    eligibility,
    settings: null,
    target: { kind: 'local' as const },
    submitting: false,
    workspace
  }
}
afterEach(cleanup)

describe('Jira review title ownership', () => {
  it.each(['github', 'gitlab'] as const)(
    'seeds and regenerates a canonical prefix for %s',
    async (provider) => {
      const { result } = renderHook(() => useCreatePullRequestDialogFields(options(provider)))
      expect(result.current.title).toBe('TEAM_ALPHA9-7 Restore login')
      expect(result.current.fieldsAreSeedPlaceholders).toBe(true)
      act(() => {
        result.current.applyGeneratedFields(fields, revisions)
      })
      expect(result.current.title).toBe('TEAM_ALPHA9-7 Restore login')
      act(() => {
        result.current.applyGeneratedFields({ ...fields, title: 'Better title' }, revisions)
      })
      expect(result.current.title).toBe('TEAM_ALPHA9-7 Better title')
    }
  )
  it('keeps a title edited during or before regeneration', () => {
    const { result } = renderHook(() => useCreatePullRequestDialogFields(options('gitlab')))
    act(() => {
      result.current.setTitle('My exact manual title')
    })
    act(() => {
      result.current.applyGeneratedFields(fields, revisions)
    })
    expect(result.current.title).toBe('My exact manual title')
    const laterRevisions = { ...result.current.fieldRevisions }
    act(() => {
      result.current.applyGeneratedFields(fields, laterRevisions)
    })
    expect(result.current.title).toBe('My exact manual title')
    expect(result.current.body).toBe('Generated body')
  })
  it('keeps a manual title when eligibility refreshes on the same branch', () => {
    const input = options('github')
    const { result, rerender } = renderHook(
      ({ eligibility }) => useCreatePullRequestDialogFields({ ...input, eligibility }),
      { initialProps: { eligibility: input.eligibility } }
    )
    act(() => {
      result.current.setTitle('Manual title')
    })
    rerender({ eligibility: { ...input.eligibility, title: 'Refreshed title' } })
    expect(result.current.title).toBe('Manual title')
  })
})
