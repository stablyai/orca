// @vitest-environment happy-dom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import React, { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PRComment } from '../../../../../shared/github/comment-types'
import type {
  GitHubWorkItem,
  GitHubWorkItemDetails
} from '../../../../../shared/github/work-item-types'
import { requestPRReviewers } from '../land-pull-request/pr-reviewers-request-actions'
import { useGitHubItemDialogDetails } from './use-github-item-dialog-details'
import {
  invalidateWorkItemDetailsCacheForKey,
  touchWorkItemDetailsCache,
  workItemDetailsCache
} from './work-item-details-cache'

const lookup = vi.hoisted(() => vi.fn())
const setViewed = vi.hoisted(() => vi.fn())
vi.mock('@/lib/github-work-item-source-lookup', () => ({
  lookupGitHubWorkItemDetailsForSource: lookup
}))
vi.mock('@/components/github/github-work-item-comment-mutations', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setPRFileViewedForRepo: setViewed
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
const comment = (id: string) =>
  ({ id, body: 'Thanks', author: 'me', createdAt: '' }) as unknown as PRComment

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
  setViewed.mockReset()
  workItemDetailsCache.clear()
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

  it('keeps a Viewed write landing on the shown files after a failed reread, and rolls back a later failed one', async () => {
    lookup.mockResolvedValueOnce({
      ...details,
      pullRequestId: 'PR_7',
      files: [{ path: 'a.ts', viewerViewedState: 'UNVIEWED' }]
    })
    render(<Harness />)
    await waitFor(() => expect(latest?.detailsLoaded).toBe(true))
    lookup.mockRejectedValueOnce(new Error('offline'))
    await act(async () => latest!.invalidateCurrentDetailsCache())
    await waitFor(() => expect(lookup).toHaveBeenCalledTimes(2))

    setViewed.mockResolvedValueOnce(true)
    await act(async () => expect(await latest!.handlePRFileViewedChange('a.ts', true)).toBe(true))
    expect(latest?.details?.files?.[0]?.viewerViewedState).toBe('VIEWED')
    setViewed.mockResolvedValueOnce(false)
    await act(async () => expect(await latest!.handlePRFileViewedChange('a.ts', false)).toBe(false))
    expect(latest?.details?.files?.[0]?.viewerViewedState).toBe('VIEWED')
    // One settlement owed exactly one read: the failed read and the local patches start none.
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('starts the owed reread when a comment lands in the same batch as the invalidation', async () => {
    lookup.mockResolvedValue(details)
    render(<Harness />)
    await waitFor(() => expect(latest?.detailsLoaded).toBe(true))

    act(() => {
      latest!.invalidateCurrentDetailsCache()
      latest!.appendOptimisticComment(comment('during-settlement'))
    })

    await waitFor(() => expect(lookup).toHaveBeenCalledTimes(2))
    await act(async () => {})
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(latest?.details?.comments.map((c) => c.id)).toContain('during-settlement')
  })

  it('lands a running reread after a comment and an unrelated invalidation', async () => {
    lookup.mockResolvedValueOnce(details)
    render(<Harness />)
    await waitFor(() => expect(latest?.detailsLoaded).toBe(true))
    const fresh = Promise.withResolvers<GitHubWorkItemDetails | null>()
    lookup.mockReturnValueOnce(fresh.promise)
    await act(async () => latest!.invalidateCurrentDetailsCache())
    expect(lookup).toHaveBeenCalledTimes(2)

    await act(async () => latest!.appendOptimisticComment(comment('during-read')))
    act(() => {
      touchWorkItemDetailsCache('other-key', { details, fetchedAt: Date.now() })
      invalidateWorkItemDetailsCacheForKey('other-key')
    })
    const merged = { ...details, item: { ...workItem, state: 'merged' } }
    await act(async () => fresh.resolve(merged as GitHubWorkItemDetails))

    expect(latest?.details?.item.state).toBe('merged')
    expect(latest?.details?.comments.map((c) => c.id)).toContain('during-read')
  })
})
