import { describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { useAppStore } from '../index'
import { createGitHubSlice } from '../slices/github'
import { createHostedReviewSlice } from '../slices/hosted-review'
import type { AppState } from '../types'

// @ts-expect-error test window mock
globalThis.window = { api: { gh: { prChecks: vi.fn() }, cache: { setGitHub: vi.fn() } } }

function createTestStore() {
  return create<AppState>()((...a) => ({
    ...useAppStore.getInitialState(),
    ...createGitHubSlice(...a),
    ...createHostedReviewSlice(...a)
  }))
}

const inFlightEvent = (sequence: number) => ({
  sequence,
  aliases: [{ cacheKey: 'repo-1::main', repoId: 'repo-1', repoPath: '/repo', branch: 'main' }],
  reason: 'visible' as const,
  status: 'in-flight' as const
})

describe('applyGitHubPRRefreshEvent no-op updates', () => {
  // Why a listener count: zustand bails out only on Object.is(next, state), so a
  // `return {}` no-op branch still rebuilds the root and wakes every selector in the
  // app. The state looks unchanged afterwards, which is exactly why it goes unnoticed.
  it('does not notify subscribers when a stale sequence changes nothing', () => {
    const store = createTestStore()
    store.getState().applyGitHubPRRefreshEvent(inFlightEvent(4))

    let notifications = 0

    const unsubscribe = store.subscribe(() => {
      notifications += 1
    })

    try {
      store.getState().applyGitHubPRRefreshEvent(inFlightEvent(4))
      store.getState().applyGitHubPRRefreshEvent(inFlightEvent(3))
    } finally {
      unsubscribe()
    }

    expect(notifications).toBe(0)
  })

  it('still notifies when the event advances the sequence', () => {
    const store = createTestStore()
    store.getState().applyGitHubPRRefreshEvent(inFlightEvent(1))

    let notifications = 0

    const unsubscribe = store.subscribe(() => {
      notifications += 1
    })

    try {
      store.getState().applyGitHubPRRefreshEvent(inFlightEvent(2))
    } finally {
      unsubscribe()
    }

    expect(notifications).toBe(1)
  })
})
