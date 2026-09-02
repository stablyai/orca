import { afterEach, describe, expect, it } from 'vitest'
import {
  clearWebSessionCloseIntent,
  clearWebSessionCloseIntentsForOwner,
  clearWebSessionCloseIntentsForWorktree,
  isWebSessionCloseIntentPending,
  reconcileWebSessionCloseIntents,
  recordWebSessionCloseIntent,
  resetWebSessionCloseIntentForTests,
  WEB_SESSION_CLOSE_INTENT_TTL_MS
} from './web-session-close-intent'
import { WEB_SESSION_TAB_RPC_TIMEOUT_MS } from './web-session-tab-rpc-timeout'

const WT = 'repo::/wt'
const OWNER = { environmentId: 'runtime-a', pairingRevision: 1 }

afterEach(() => resetWebSessionCloseIntentForTests())

describe('web session close intent', () => {
  it('keeps an intent until the host confirms removal', () => {
    recordWebSessionCloseIntent(OWNER, WT, 'host-tab-1', 1000)
    reconcileWebSessionCloseIntents(OWNER, WT, new Set(['host-tab-1', 'host-tab-2']))
    expect(isWebSessionCloseIntentPending(OWNER, WT, 'host-tab-1', 1000)).toBe(true)

    reconcileWebSessionCloseIntents(OWNER, WT, new Set(['host-tab-2']))
    expect(isWebSessionCloseIntentPending(OWNER, WT, 'host-tab-1', 1000)).toBe(false)
  })

  it('expires a never-confirmed close', () => {
    recordWebSessionCloseIntent(OWNER, WT, 'host-tab-1', 1000)
    expect(
      isWebSessionCloseIntentPending(
        OWNER,
        WT,
        'host-tab-1',
        1000 + WEB_SESSION_CLOSE_INTENT_TTL_MS + 1
      )
    ).toBe(false)
  })

  // The durable flip in the tab_not_found path can only reach an entry that is still there, so the
  // TTL must outlast the RPC that produces that answer. Two independent literals would drift.
  it('outlives the tab RPC that can still answer tab_not_found', () => {
    expect(WEB_SESSION_CLOSE_INTENT_TTL_MS).toBeGreaterThan(WEB_SESSION_TAB_RPC_TIMEOUT_MS)
  })

  it('scopes intents by owner, pairing revision, and worktree', () => {
    recordWebSessionCloseIntent(OWNER, WT, 'host-tab-1', 1000)

    expect(
      isWebSessionCloseIntentPending(
        { environmentId: 'runtime-b', pairingRevision: 1 },
        WT,
        'host-tab-1',
        1000
      )
    ).toBe(false)
    expect(
      isWebSessionCloseIntentPending(
        { environmentId: 'runtime-a', pairingRevision: 2 },
        WT,
        'host-tab-1',
        1000
      )
    ).toBe(false)
    expect(isWebSessionCloseIntentPending(OWNER, 'other::/wt', 'host-tab-1', 1000)).toBe(false)
  })

  it('clears one tab, one worktree, or one owner without crossing partitions', () => {
    const otherOwner = { environmentId: 'runtime-b', pairingRevision: 1 }
    recordWebSessionCloseIntent(OWNER, WT, 'host-tab-1', 1000)
    recordWebSessionCloseIntent(OWNER, WT, 'host-tab-2', 1000)
    recordWebSessionCloseIntent(OWNER, 'other-wt', 'host-tab-3', 1000)
    recordWebSessionCloseIntent(otherOwner, WT, 'host-tab-4', 1000)

    clearWebSessionCloseIntent(OWNER, WT, 'host-tab-1')
    expect(isWebSessionCloseIntentPending(OWNER, WT, 'host-tab-2', 1000)).toBe(true)
    clearWebSessionCloseIntentsForWorktree(OWNER, WT)
    expect(isWebSessionCloseIntentPending(OWNER, WT, 'host-tab-2', 1000)).toBe(false)
    expect(isWebSessionCloseIntentPending(OWNER, 'other-wt', 'host-tab-3', 1000)).toBe(true)
    clearWebSessionCloseIntentsForOwner(OWNER)
    expect(isWebSessionCloseIntentPending(OWNER, 'other-wt', 'host-tab-3', 1000)).toBe(false)
    expect(isWebSessionCloseIntentPending(otherOwner, WT, 'host-tab-4', 1000)).toBe(true)
  })

  it('ignores empty ids', () => {
    recordWebSessionCloseIntent(OWNER, WT, '   ', 1000)
    expect(isWebSessionCloseIntentPending(OWNER, WT, '', 1000)).toBe(false)
  })
})
