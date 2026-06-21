// @vitest-environment happy-dom

import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import type { HostedReviewCreationEligibility } from '../../../../shared/hosted-review'
import {
  normalizeCreateReviewBaseSearchResults,
  useCreatePullRequestDialogFields
} from './useCreatePullRequestDialogFields'

describe('normalizeCreateReviewBaseSearchResults', () => {
  it('uses detailed local branch names for base refs from arbitrary remotes', () => {
    expect(
      normalizeCreateReviewBaseSearchResults([
        {
          refName: 'mycorp-fork/main',
          localBranchName: 'main'
        }
      ])
    ).toEqual(['main'])
  })

  it('dedupes equivalent base branches found on multiple remotes', () => {
    expect(
      normalizeCreateReviewBaseSearchResults([
        {
          refName: 'origin/main',
          localBranchName: 'main'
        },
        {
          refName: 'upstream/main',
          localBranchName: 'main'
        },
        {
          refName: 'mycorp-fork/release/1.0',
          localBranchName: 'release/1.0'
        }
      ])
    ).toEqual(['main', 'release/1.0'])
  })
})

function createEligibility(
  overrides: Partial<HostedReviewCreationEligibility> = {}
): HostedReviewCreationEligibility {
  return {
    provider: 'github',
    review: null,
    canCreate: true,
    blockedReason: null,
    nextAction: null,
    defaultBaseRef: 'refs/remotes/origin/main',
    title: 'Review title',
    body: 'Review body',
    ...overrides
  }
}

type DialogFields = ReturnType<typeof useCreatePullRequestDialogFields>

type DialogFieldsRenderInput = {
  eligibility: HostedReviewCreationEligibility
  currentBaseRef?: string | null
}

function renderDialogFields(input: DialogFieldsRenderInput): {
  current: () => DialogFields
  rerender: (nextInput: DialogFieldsRenderInput) => Promise<void>
  unmount: () => void
} {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  let latest: DialogFields | null = null
  let currentInput = input

  function Harness(): null {
    latest = useCreatePullRequestDialogFields({
      open: true,
      repoId: 'repo-1',
      worktreeId: 'wt-1',
      worktreePath: '/repo/wt',
      branch: 'feature/base-change',
      eligibility: currentInput.eligibility,
      currentBaseRef: currentInput.currentBaseRef,
      settings: null,
      submitting: false
    })
    return null
  }

  function current(): DialogFields {
    if (!latest) {
      throw new Error('dialog fields were not rendered')
    }
    return latest
  }

  async function render(): Promise<void> {
    await act(async () => {
      root.render(React.createElement(Harness))
      await Promise.resolve()
    })
  }

  return {
    current,
    rerender: async (nextInput) => {
      currentInput = nextInput
      await render()
    },
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    }
  }
}

describe('useCreatePullRequestDialogFields', () => {
  it('updates an untouched base field when the creation default changes for the same branch', async () => {
    const harness = renderDialogFields({ eligibility: createEligibility() })
    try {
      await harness.rerender({ eligibility: createEligibility() })
      expect(harness.current().base).toBe('main')

      await harness.rerender({
        eligibility: createEligibility({
          defaultBaseRef: 'refs/remotes/origin/release'
        })
      })

      expect(harness.current().base).toBe('release')
      expect(harness.current().title).toBe('Review title')
      expect(harness.current().body).toBe('Review body')

      await harness.rerender({
        eligibility: createEligibility({
          defaultBaseRef: 'refs/remotes/origin/develop'
        })
      })

      expect(harness.current().base).toBe('develop')
    } finally {
      harness.unmount()
    }
  })

  it('prefers the selected current base ref over stale eligibility defaults', async () => {
    const harness = renderDialogFields({
      eligibility: createEligibility({ defaultBaseRef: 'refs/remotes/origin/main' }),
      currentBaseRef: 'refs/remotes/origin/release'
    })
    try {
      await harness.rerender({
        eligibility: createEligibility({ defaultBaseRef: 'refs/remotes/origin/main' }),
        currentBaseRef: 'refs/remotes/origin/release'
      })

      expect(harness.current().base).toBe('release')
    } finally {
      harness.unmount()
    }
  })

  it('keeps a user-edited base when the default base ref changes', async () => {
    const harness = renderDialogFields({
      eligibility: createEligibility(),
      currentBaseRef: 'refs/remotes/origin/main'
    })
    try {
      await harness.rerender({
        eligibility: createEligibility(),
        currentBaseRef: 'refs/remotes/origin/main'
      })
      act(() => {
        harness.current().setBase('custom-target')
      })

      await harness.rerender({
        eligibility: createEligibility({
          defaultBaseRef: 'refs/remotes/origin/release'
        }),
        currentBaseRef: 'refs/remotes/origin/release'
      })

      expect(harness.current().base).toBe('custom-target')
    } finally {
      harness.unmount()
    }
  })

  it('keeps a synced base when stale generated fields arrive', async () => {
    const harness = renderDialogFields({
      eligibility: createEligibility(),
      currentBaseRef: 'refs/remotes/origin/main'
    })
    try {
      await harness.rerender({
        eligibility: createEligibility(),
        currentBaseRef: 'refs/remotes/origin/main'
      })
      const seedRevisions = { ...harness.current().fieldRevisions }

      await harness.rerender({
        eligibility: createEligibility(),
        currentBaseRef: 'refs/remotes/origin/release'
      })
      expect(harness.current().base).toBe('release')

      act(() => {
        harness.current().applyGeneratedFields(
          {
            base: 'main',
            title: 'Generated title',
            body: 'Generated body',
            draft: true
          },
          seedRevisions
        )
      })

      expect(harness.current().base).toBe('release')
      expect(harness.current().title).toBe('Generated title')
      expect(harness.current().body).toBe('Generated body')
      expect(harness.current().draft).toBe(true)
    } finally {
      harness.unmount()
    }
  })
})
