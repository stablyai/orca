import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import { requestPRReviewers } from './pr-reviewers-request-actions'

const toastMocks = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))

vi.mock('sonner', () => ({ toast: toastMocks }))

describe('GitHub dialog reviewer actions', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('rereads after a returned failure without applying the reviewer patch', async () => {
    const requestReviewers = vi.fn().mockResolvedValue({ ok: false, error: 'Connection lost' })
    vi.stubGlobal('window', { api: { gh: { requestPRReviewers: requestReviewers } } })
    const events: string[] = []
    const patchWorkItem = vi.fn()

    await requestPRReviewers({
      submitting: false,
      requestedLogins: ['octocat'],
      reviewerInput: '',
      selectedReviewerLogins: new Set(),
      localReviewRequests: [],
      ownerTarget: { kind: 'local' },
      repoPath: '/repo',
      item: { id: 'pr:7', type: 'pr', number: 7, repoId: 'repo-1' } as GitHubWorkItem,
      reviewRepo: null,
      reviewerPanelMountedRef: { current: true },
      reviewerCandidates: [],
      setSubmitting: (value) => events.push(`submitting:${value}`),
      setLocalReviewRequests: vi.fn(),
      setReviewerInput: vi.fn(),
      patchWorkItem,
      onReviewersRequested: vi.fn(),
      onMutated: () => events.push('reread')
    })

    expect(requestReviewers).toHaveBeenCalledTimes(1)
    expect(toastMocks.error).toHaveBeenCalledWith('Connection lost')
    expect(patchWorkItem).not.toHaveBeenCalled()
    expect(events).toEqual(['submitting:true', 'submitting:false', 'reread'])
  })
})
