import { afterEach, describe, expect, it } from 'vitest'
import {
  isWebSessionCloseIntentPending,
  reconcileWebSessionCloseIntents,
  recordWebSessionCloseIntent,
  resetWebSessionCloseIntentForTests
} from './web-session-close-intent'

const WT = 'repo::/wt'

afterEach(() => resetWebSessionCloseIntentForTests())

describe('web session close intent', () => {
  it('marks a closing host tab pending until the host confirms removal', () => {
    recordWebSessionCloseIntent(WT, 'host-tab-1', 1000)
    expect(isWebSessionCloseIntentPending(WT, 'host-tab-1', 1000)).toBe(true)

    // A snapshot that still contains the tab keeps the intent (not confirmed).
    reconcileWebSessionCloseIntents(WT, new Set(['host-tab-1', 'host-tab-2']))
    expect(isWebSessionCloseIntentPending(WT, 'host-tab-1', 1000)).toBe(true)

    // A snapshot WITHOUT the tab confirms removal and clears the intent.
    reconcileWebSessionCloseIntents(WT, new Set(['host-tab-2']))
    expect(isWebSessionCloseIntentPending(WT, 'host-tab-1', 1000)).toBe(false)
  })

  it('expires a never-confirmed close so the tab is not hidden forever', () => {
    recordWebSessionCloseIntent(WT, 'host-tab-1', 1000)
    expect(isWebSessionCloseIntentPending(WT, 'host-tab-1', 1000)).toBe(true)
    // Past the TTL with no confirming snapshot — stop suppressing.
    expect(isWebSessionCloseIntentPending(WT, 'host-tab-1', 1000 + 11_000)).toBe(false)
  })

  it('scopes intents per worktree', () => {
    recordWebSessionCloseIntent(WT, 'host-tab-1', 1000)
    expect(isWebSessionCloseIntentPending('other::/wt', 'host-tab-1', 1000)).toBe(false)
  })

  it('ignores empty ids', () => {
    recordWebSessionCloseIntent(WT, '   ', 1000)
    expect(isWebSessionCloseIntentPending(WT, '', 1000)).toBe(false)
  })
})
