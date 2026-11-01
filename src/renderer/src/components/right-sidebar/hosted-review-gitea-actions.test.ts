import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'

const api = vi.hoisted(() => ({
  mergePR: vi.fn(),
  closePR: vi.fn(),
  reopenPR: vi.fn(),
  updatePR: vi.fn()
}))
const giteaApiFor = vi.hoisted(() => vi.fn())

vi.mock('@/runtime/gitea-owner-api', () => ({ giteaApiFor }))

import {
  markGiteaReviewReady,
  mergeGiteaHostedReview,
  updateGiteaHostedReviewState
} from './hosted-review-gitea-actions'

// SAFETY: only the fields read by the action helpers are populated.
const repo = { id: 'repo-1', path: '/work/app' } as Repo
const base = { repoPath: '/work/app', repoId: 'repo-1', number: 7 }

beforeEach(() => {
  for (const fn of Object.values(api)) {
    fn.mockReset().mockResolvedValue({ ok: true })
  }
  giteaApiFor.mockReset().mockReturnValue(api)
})

describe('Gitea hosted review actions', () => {
  it('merges through the owner-routed Gitea API', async () => {
    await expect(mergeGiteaHostedReview({ repo, prNumber: 7, method: 'squash' })).resolves.toEqual({
      ok: true
    })

    expect(giteaApiFor).toHaveBeenCalledWith(expect.objectContaining({ repoPath: '/work/app' }))
    expect(api.mergePR).toHaveBeenCalledWith({ ...base, method: 'squash' })
  })

  it('closes and reopens by state', async () => {
    await updateGiteaHostedReviewState({ repo, prNumber: 7, nextState: 'closed' })
    await updateGiteaHostedReviewState({ repo, prNumber: 7, nextState: 'open' })

    expect(api.closePR).toHaveBeenCalledWith(base)
    expect(api.reopenPR).toHaveBeenCalledWith(base)
  })

  it('marks a draft ready for review', async () => {
    await markGiteaReviewReady({ repo, prNumber: 7 })

    expect(api.updatePR).toHaveBeenCalledWith({ ...base, updates: { draft: false } })
  })
})
