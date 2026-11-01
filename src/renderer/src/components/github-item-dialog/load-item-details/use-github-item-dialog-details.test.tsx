// @vitest-environment happy-dom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import React, { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  GitHubWorkItem,
  GitHubWorkItemDetails
} from '../../../../../shared/github/work-item-types'
import { requestPRReviewers } from '../land-pull-request/pr-reviewers-request-actions'
import { useGitHubItemDialogDetails } from './use-github-item-dialog-details'

const lookup = vi.hoisted(() => vi.fn())
vi.mock('@/lib/github-work-item-source-lookup', () => ({
  lookupGitHubWorkItemDetailsForSource: lookup
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const workItem = {
  id: 'pr:7',
  type: 'pr',
  number: 7,
  repoId: 'repo-1',
  title: 'PR',
  state: 'open',
  url: 'https://github.com/acme/widgets/pull/7',
  labels: []
} as unknown as GitHubWorkItem
const details = { item: workItem, body: 'Body', comments: [] } as unknown as GitHubWorkItemDetails

let latest: ReturnType<typeof useGitHubItemDialogDetails> | null = null
let setDraft: (value: string) => void = () => {}

// Stands in for GHCommentComposer, whose unsent body is component-local state.
function DraftComposer(): React.JSX.Element {
  const [draft, setLocalDraft] = useState('')
  setDraft = setLocalDraft
  return <textarea aria-label="comment draft" value={draft} readOnly />
}

function Harness(): React.JSX.Element | null {
  latest = useGitHubItemDialogDetails({ workItem, repoPath: '/repo', effectiveRepoId: 'repo-1' })
  // Same gate as the Conversation tab's composer (discuss-item/conversation-tab.tsx).
  return latest.detailsLoaded ? <DraftComposer /> : null
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  lookup.mockReset()
})

describe('useGitHubItemDialogDetails reconciliation', () => {
  it('keeps an unsent comment draft through a failed reviewer write and its failed reread', async () => {
    lookup.mockResolvedValueOnce(details)
    render(<Harness />)
    await waitFor(() => expect(screen.getByLabelText('comment draft')).toBeTruthy())
    act(() => setDraft('Please also update the tests'))

    const reread = Promise.withResolvers<GitHubWorkItemDetails | null>()
    lookup.mockReturnValueOnce(reread.promise)
    vi.stubGlobal('api', {
      gh: { requestPRReviewers: vi.fn().mockResolvedValue({ ok: false, error: 'Connection lost' }) }
    })
    await act(async () =>
      requestPRReviewers({
        submitting: false,
        requestedLogins: ['octocat'],
        reviewerInput: '',
        selectedReviewerLogins: new Set(),
        localReviewRequests: [],
        ownerTarget: { kind: 'local' },
        repoPath: '/repo',
        item: workItem,
        reviewRepo: null,
        reviewerPanelMountedRef: { current: true },
        reviewerCandidates: [],
        setSubmitting: vi.fn(),
        setLocalReviewRequests: vi.fn(),
        setReviewerInput: vi.fn(),
        patchWorkItem: vi.fn(),
        onReviewersRequested: vi.fn(),
        onMutated: latest!.invalidateCurrentDetailsCache
      })
    )

    expect(lookup).toHaveBeenCalledTimes(2)
    expect(screen.getByLabelText<HTMLTextAreaElement>('comment draft').value).toBe(
      'Please also update the tests'
    )
    await act(async () => reread.reject(new Error('offline')))

    expect(screen.getByLabelText<HTMLTextAreaElement>('comment draft').value).toBe(
      'Please also update the tests'
    )
    expect(latest?.error).toBeNull()
    expect(latest?.details?.body).toBe('Body')
    expect(lookup).toHaveBeenCalledTimes(2)
  })
})
