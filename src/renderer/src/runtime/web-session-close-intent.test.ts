import { afterEach, describe, expect, it } from 'vitest'
import {
  clearWebSessionCloseIntent,
  clearWebSessionCloseIntentsForEnvironment,
  clearWebSessionCloseIntentsForRuntimeWorktree,
  isWebSessionCloseIntentPending,
  reconcileWebSessionCloseIntents,
  recordWebSessionCloseIntent,
  resetWebSessionCloseIntentForTests
} from './web-session-close-intent'

const WT = 'repo::/wt'
const ENV = 'runtime-a'

afterEach(() => resetWebSessionCloseIntentForTests())

describe('web session close intent', () => {
  it('marks a closing host tab pending until the host confirms removal', () => {
    recordWebSessionCloseIntent(ENV, WT, 'host-tab-1', 1000)
    expect(isWebSessionCloseIntentPending(ENV, WT, 'host-tab-1', 1000)).toBe(true)

    // A snapshot that still contains the tab keeps the intent (not confirmed).
    reconcileWebSessionCloseIntents(ENV, WT, new Set(['host-tab-1', 'host-tab-2']))
    expect(isWebSessionCloseIntentPending(ENV, WT, 'host-tab-1', 1000)).toBe(true)

    // A snapshot WITHOUT the tab confirms removal and clears the intent.
    reconcileWebSessionCloseIntents(ENV, WT, new Set(['host-tab-2']))
    expect(isWebSessionCloseIntentPending(ENV, WT, 'host-tab-1', 1000)).toBe(false)
  })

  it('expires a never-confirmed close so the tab is not hidden forever', () => {
    recordWebSessionCloseIntent(ENV, WT, 'host-tab-1', 1000)
    expect(isWebSessionCloseIntentPending(ENV, WT, 'host-tab-1', 1000)).toBe(true)
    // Past the TTL with no confirming snapshot — stop suppressing.
    expect(isWebSessionCloseIntentPending(ENV, WT, 'host-tab-1', 1000 + 11_000)).toBe(false)
  })

  it('scopes intents per worktree', () => {
    recordWebSessionCloseIntent(ENV, WT, 'host-tab-1', 1000)
    expect(isWebSessionCloseIntentPending(ENV, 'other::/wt', 'host-tab-1', 1000)).toBe(false)
  })

  it('scopes intents per runtime environment', () => {
    recordWebSessionCloseIntent(ENV, WT, 'host-tab-1', 1000)
    expect(isWebSessionCloseIntentPending('runtime-b', WT, 'host-tab-1', 1000)).toBe(false)
    reconcileWebSessionCloseIntents('runtime-b', WT, new Set())
    clearWebSessionCloseIntent('runtime-b', WT, 'host-tab-1')
    expect(isWebSessionCloseIntentPending(ENV, WT, 'host-tab-1', 1000)).toBe(true)
  })

  it('clears only the refused host tab intent', () => {
    recordWebSessionCloseIntent(ENV, WT, 'host-tab-1', 1000)
    recordWebSessionCloseIntent(ENV, WT, 'host-tab-2', 1000)

    clearWebSessionCloseIntent(ENV, WT, 'host-tab-1')

    expect(isWebSessionCloseIntentPending(ENV, WT, 'host-tab-1', 1000)).toBe(false)
    expect(isWebSessionCloseIntentPending(ENV, WT, 'host-tab-2', 1000)).toBe(true)
  })

  it('clears intents when their worktree or runtime owner is removed', () => {
    recordWebSessionCloseIntent(ENV, WT, 'host-tab-1', 1000)
    recordWebSessionCloseIntent(ENV, 'other-wt', 'host-tab-2', 1000)
    recordWebSessionCloseIntent('runtime-b', WT, 'host-tab-3', 1000)

    clearWebSessionCloseIntentsForRuntimeWorktree(ENV, WT)
    expect(isWebSessionCloseIntentPending(ENV, WT, 'host-tab-1', 1000)).toBe(false)
    expect(isWebSessionCloseIntentPending(ENV, 'other-wt', 'host-tab-2', 1000)).toBe(true)
    clearWebSessionCloseIntentsForEnvironment(ENV)
    expect(isWebSessionCloseIntentPending(ENV, 'other-wt', 'host-tab-2', 1000)).toBe(false)
    expect(isWebSessionCloseIntentPending('runtime-b', WT, 'host-tab-3', 1000)).toBe(true)
  })

  it('ignores empty ids', () => {
    recordWebSessionCloseIntent(ENV, WT, '   ', 1000)
    expect(isWebSessionCloseIntentPending(ENV, WT, '', 1000)).toBe(false)
  })
})
