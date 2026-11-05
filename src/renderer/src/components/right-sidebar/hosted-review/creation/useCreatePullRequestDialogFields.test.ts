// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, expect, it } from 'vitest'

import type { HostedReviewCreationEligibility } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'

import { normalizeCreateReviewBaseSearchResults } from '../../../../../../shared/source-control/hosted-review/hosted-review-refs'
import { useCreatePullRequestDialogFields } from './useCreatePullRequestDialogFields'

describe('normalizeCreateReviewBaseSearchResults', () => {
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
    reviewLookupOutcome: 'not_found',
    defaultBaseRef: 'refs/remotes/origin/main',
    title: 'Review title',
    body: 'Review body',
    ...overrides
  }
}

type DialogFields = ReturnType<typeof useCreatePullRequestDialogFields>
type DialogGeneration = NonNullable<
  Parameters<typeof useCreatePullRequestDialogFields>[0]['generation']
>

type DialogFieldsRenderInput = {
  eligibility: HostedReviewCreationEligibility
  currentBaseRef?: string | null
  generation?: DialogGeneration
  worktreeId?: string | null
  branch?: string
  settings?: Parameters<typeof useCreatePullRequestDialogFields>[0]['settings']
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
      worktreeId: currentInput.worktreeId ?? 'wt-1',
      worktreePath: '/repo/wt',
      branch: currentInput.branch ?? 'feature/base-change',
      eligibility: currentInput.eligibility,
      currentBaseRef: currentInput.currentBaseRef,
      settings: currentInput.settings ?? null,
      target: { kind: 'local' },
      submitting: false,
      generation: currentInput.generation
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
        eligibility: createEligibility({ defaultBaseRef: 'refs/remotes/origin/release' }),
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
