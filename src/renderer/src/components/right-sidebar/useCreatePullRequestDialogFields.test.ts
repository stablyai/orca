// @vitest-environment happy-dom

import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
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
      settings: null,
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

  it('prefers the remote-validated eligibility default over a stacked local-only base', async () => {
    // Why: for a stacked worktree the current base is the local-only parent
    // branch, which the main process resolves to the repo default. The seeded
    // field must follow the remote-validated eligibility default, not the parent.
    const harness = renderDialogFields({
      eligibility: createEligibility({ defaultBaseRef: 'refs/remotes/origin/main' }),
      currentBaseRef: 'stacked-parent'
    })
    try {
      await harness.rerender({
        eligibility: createEligibility({ defaultBaseRef: 'refs/remotes/origin/main' }),
        currentBaseRef: 'stacked-parent'
      })

      expect(harness.current().base).toBe('main')
    } finally {
      harness.unmount()
    }
  })

  it('falls back to the current base ref when eligibility supplies no default', async () => {
    // Why: when the main process cannot resolve a default (e.g. origin/HEAD
    // unset and no probes match), keep the current base rather than blanking it.
    const harness = renderDialogFields({
      eligibility: createEligibility({ defaultBaseRef: null }),
      currentBaseRef: 'refs/remotes/origin/release'
    })
    try {
      await harness.rerender({
        eligibility: createEligibility({ defaultBaseRef: null }),
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

  it('restores an external generation seed once after remount', async () => {
    const seedFieldRevisions = {
      base: 0,
      title: 1,
      body: 1,
      draft: 0
    }
    const generation: DialogGeneration = {
      generating: true,
      generateError: null,
      seedRestoreKey: 'repo-1:wt-1:feature:1',
      seed: {
        base: 'release',
        title: 'Seed title edited before generation',
        body: 'Seed body edited before generation',
        draft: true
      },
      seedFieldRevisions,
      onSeedRestored: vi.fn(),
      onGenerate: () => undefined,
      onCancelGenerate: () => undefined
    }
    const harness = renderDialogFields({
      eligibility: createEligibility(),
      generation
    })
    try {
      await harness.rerender({
        eligibility: createEligibility(),
        generation
      })

      expect(harness.current().base).toBe('release')
      expect(harness.current().title).toBe('Seed title edited before generation')
      expect(harness.current().body).toBe('Seed body edited before generation')
      expect(harness.current().draft).toBe(true)
      expect(harness.current().fieldRevisions).toEqual(seedFieldRevisions)
      expect(generation.onSeedRestored).toHaveBeenCalledTimes(1)

      act(() => {
        harness.current().setTitle('User edit after remount')
      })
      await harness.rerender({
        eligibility: createEligibility(),
        generation
      })

      expect(harness.current().title).toBe('User edit after remount')
      expect(harness.current().fieldRevisions.title).toBe(2)
      expect(generation.onSeedRestored).toHaveBeenCalledTimes(1)

      await harness.rerender({
        eligibility: createEligibility({ title: 'Other branch title' }),
        branch: 'feature/other'
      })
      expect(harness.current().title).toBe('Other branch title')

      await harness.rerender({
        eligibility: createEligibility(),
        generation
      })
      expect(harness.current().title).toBe('Seed title edited before generation')
      expect(generation.onSeedRestored).toHaveBeenCalledTimes(2)
    } finally {
      harness.unmount()
    }
  })
})
