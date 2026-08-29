// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostedReviewCreationEligibility } from '../../../../shared/hosted-review'

const getRuntimeRepoBaseRefDefault = vi.fn()

vi.mock('@/runtime/runtime-repo-client', () => ({
  getRuntimeRepoBaseRefDefault: (...args: unknown[]) => getRuntimeRepoBaseRefDefault(...args),
  searchRuntimeRepoBaseRefDetails: vi.fn(async () => [])
}))

const { useCreatePullRequestDialogFields } = await import('./useCreatePullRequestDialogFields')

type DialogFields = ReturnType<typeof useCreatePullRequestDialogFields>

function eligibilityFor(defaultBaseRef: string): HostedReviewCreationEligibility {
  return {
    provider: 'github',
    review: null,
    canCreate: true,
    blockedReason: null,
    nextAction: null,
    reviewLookupOutcome: 'not_found',
    defaultBaseRef,
    title: 'Review title',
    body: 'Review body'
  }
}

function renderFields(initialRepoId: string): {
  current: () => DialogFields
  switchRepo: (repoId: string, defaultBaseRef: string) => Promise<void>
  unmount: () => void
} {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  let latest: DialogFields | null = null
  let repoId = initialRepoId
  let eligibility = eligibilityFor('refs/remotes/origin/main')

  function Harness(): null {
    latest = useCreatePullRequestDialogFields({
      open: true,
      repoId,
      worktreeId: `wt-${repoId}`,
      worktreePath: '/repo/wt',
      branch: 'feature/child',
      eligibility,
      settings: null,
      submitting: false
    })
    return null
  }

  const render = async (): Promise<void> => {
    await act(async () => {
      root.render(React.createElement(Harness))
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  return {
    current: () => {
      if (!latest) {
        throw new Error('dialog fields were not rendered')
      }
      return latest
    },
    switchRepo: async (nextRepoId, defaultBaseRef) => {
      repoId = nextRepoId
      eligibility = eligibilityFor(defaultBaseRef)
      await render()
    },
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    }
  }
}

beforeEach(() => {
  getRuntimeRepoBaseRefDefault.mockReset()
})

describe('useCreatePullRequestDialogFields repo default base ref', () => {
  it('reports the repo default branch, not the worktree base from eligibility', async () => {
    getRuntimeRepoBaseRefDefault.mockResolvedValue({
      defaultBaseRef: 'refs/remotes/origin/main',
      remoteCount: 1
    })
    const harness = renderFields('repo-1')
    try {
      await harness.switchRepo('repo-1', 'refs/remotes/origin/feature/parent')

      expect(harness.current().repoDefaultBaseRef).toBe('main')
      // Eligibility still drives the field itself; only the "is this the repo
      // default?" answer comes from the repo lookup.
      expect(harness.current().base).toBe('feature/parent')
    } finally {
      harness.unmount()
    }
  })

  it('probes the repo default once per repo', async () => {
    getRuntimeRepoBaseRefDefault.mockResolvedValue({
      defaultBaseRef: 'refs/remotes/origin/main',
      remoteCount: 1
    })
    const harness = renderFields('repo-1')
    try {
      await harness.switchRepo('repo-1', 'refs/remotes/origin/feature/parent')
      await harness.switchRepo('repo-1', 'refs/remotes/origin/feature/other')

      expect(getRuntimeRepoBaseRefDefault).toHaveBeenCalledTimes(1)
      expect(harness.current().repoDefaultBaseRef).toBe('main')
    } finally {
      harness.unmount()
    }
  })

  it('drops a previous repo default instead of applying it to the next repo', async () => {
    getRuntimeRepoBaseRefDefault.mockResolvedValue({
      defaultBaseRef: 'refs/remotes/origin/main',
      remoteCount: 1
    })
    const harness = renderFields('repo-1')
    try {
      await harness.switchRepo('repo-1', 'refs/remotes/origin/main')
      expect(harness.current().repoDefaultBaseRef).toBe('main')

      getRuntimeRepoBaseRefDefault.mockReturnValue(new Promise(() => {}))
      await harness.switchRepo('repo-2', 'refs/remotes/origin/trunk')

      expect(harness.current().repoDefaultBaseRef).toBeNull()
    } finally {
      harness.unmount()
    }
  })
})
