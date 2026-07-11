import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_WEB_SESSION_CLOSE_INTENT_SCOPES,
  MAX_WEB_SESSION_CLOSE_INTENTS_PER_SCOPE,
  clearWebSessionCloseIntent,
  clearWebSessionCloseIntentsForEnvironment,
  clearWebSessionCloseIntentsForWorktree,
  getWebSessionCloseIntentCountsForTests,
  isWebSessionCloseIntentPending,
  reconcileWebSessionCloseIntents,
  recordWebSessionCloseIntent,
  resetWebSessionCloseIntentForTests
} from './web-session-close-intent'
import type { WebSessionIntentScope } from './web-session-intent-scope'

const SCOPE = { environmentId: 'env-a', worktreeId: 'repo::/wt' }
const EPOCH = 'host-generation-a'
const NOW = 1_000

afterEach(() => resetWebSessionCloseIntentForTests())

function scope(environmentId: string, worktreeId: string): WebSessionIntentScope {
  return { environmentId, worktreeId }
}

function isPending(
  intentScope: WebSessionIntentScope,
  hostTabId: string,
  now = NOW,
  epoch = EPOCH
): boolean {
  return isWebSessionCloseIntentPending(intentScope, hostTabId, now, epoch)
}

describe('web session close intent', () => {
  it('stays pending until the same host generation confirms removal', () => {
    recordWebSessionCloseIntent(SCOPE, 'host-tab-1', NOW, EPOCH)
    expect(isPending(SCOPE, 'host-tab-1')).toBe(true)

    reconcileWebSessionCloseIntents(SCOPE, new Set(['host-tab-1', 'host-tab-2']), NOW, EPOCH)
    expect(isPending(SCOPE, 'host-tab-1')).toBe(true)

    reconcileWebSessionCloseIntents(SCOPE, new Set(['host-tab-2']), NOW, EPOCH)
    expect(isPending(SCOPE, 'host-tab-1')).toBe(false)
  })

  it('survives a slow reconnect longer than ten seconds', () => {
    recordWebSessionCloseIntent(SCOPE, 'host-tab-1', NOW, EPOCH)

    expect(isPending(SCOPE, 'host-tab-1', NOW + 120_000)).toBe(true)
  })

  it('isolates identical worktree and tab ids across hosts and generations', () => {
    const otherHost = scope('env-b', SCOPE.worktreeId)
    recordWebSessionCloseIntent(SCOPE, 'reused-tab', NOW, EPOCH)
    recordWebSessionCloseIntent(otherHost, 'reused-tab', NOW, 'epoch-b')

    expect(isPending(SCOPE, 'reused-tab', NOW, 'epoch-b')).toBe(false)
    expect(isPending(SCOPE, 'reused-tab', NOW, EPOCH)).toBe(true)
    expect(isPending(otherHost, 'reused-tab', NOW, 'epoch-b')).toBe(true)
  })

  it('suppresses a late pre-close frame after success and concurrent epoch advances', () => {
    recordWebSessionCloseIntent(SCOPE, 'reused-tab', NOW, 'before-close')

    reconcileWebSessionCloseIntents(SCOPE, new Set(), NOW + 1, 'close-success')
    expect(isPending(SCOPE, 'reused-tab', NOW + 2, 'concurrent-newer')).toBe(false)
    expect(isPending(SCOPE, 'reused-tab', NOW + 3, 'before-close')).toBe(true)
    expect(isPending(SCOPE, 'reused-tab', NOW + 120_000, 'before-close')).toBe(true)
  })

  it('does not let an older failed RPC clear a newer retry', () => {
    const older = recordWebSessionCloseIntent(SCOPE, 'host-tab-1', NOW, EPOCH)
    const newer = recordWebSessionCloseIntent(SCOPE, 'host-tab-1', NOW + 1, EPOCH)
    expect(older).not.toBeNull()
    expect(newer).not.toBeNull()

    clearWebSessionCloseIntent(SCOPE, 'host-tab-1', older!)

    expect(isPending(SCOPE, 'host-tab-1', NOW + 1)).toBe(true)
  })

  it('clears only the current retry when the newer RPC fails first', () => {
    recordWebSessionCloseIntent(SCOPE, 'host-tab-1', NOW, EPOCH)
    const newer = recordWebSessionCloseIntent(SCOPE, 'host-tab-1', NOW + 1, EPOCH)

    clearWebSessionCloseIntent(SCOPE, 'host-tab-1', newer!)

    expect(isPending(SCOPE, 'host-tab-1', NOW + 1)).toBe(false)
  })

  it('bounds 10k tab intents inside one scope', () => {
    for (let i = 0; i < 10_000; i += 1) {
      recordWebSessionCloseIntent(SCOPE, `host-tab-${i}`, NOW, EPOCH)
    }

    expect(getWebSessionCloseIntentCountsForTests()).toEqual({
      scopes: 1,
      tabs: MAX_WEB_SESSION_CLOSE_INTENTS_PER_SCOPE
    })
    expect(isPending(SCOPE, 'host-tab-0')).toBe(false)
    expect(isPending(SCOPE, 'host-tab-9999')).toBe(true)
  })

  it('bounds 10k host-worktree scopes', () => {
    for (let i = 0; i < 10_000; i += 1) {
      recordWebSessionCloseIntent(
        scope(`env-${i}`, `worktree-${i}`),
        `host-tab-${i}`,
        NOW,
        `epoch-${i}`
      )
    }

    expect(getWebSessionCloseIntentCountsForTests()).toEqual({
      scopes: MAX_WEB_SESSION_CLOSE_INTENT_SCOPES,
      tabs: MAX_WEB_SESSION_CLOSE_INTENT_SCOPES
    })
    expect(isPending(scope('env-0', 'worktree-0'), 'host-tab-0', NOW, 'epoch-0')).toBe(false)
  })

  it('clears one worktree or environment without touching another host', () => {
    const sibling = scope(SCOPE.environmentId, 'repo::/sibling')
    const otherHost = scope('env-b', SCOPE.worktreeId)
    recordWebSessionCloseIntent(SCOPE, 'tab-a', NOW, EPOCH)
    recordWebSessionCloseIntent(sibling, 'tab-b', NOW, EPOCH)
    recordWebSessionCloseIntent(otherHost, 'tab-c', NOW, 'epoch-b')

    clearWebSessionCloseIntentsForWorktree(SCOPE)
    expect(isPending(SCOPE, 'tab-a')).toBe(false)
    expect(isPending(sibling, 'tab-b')).toBe(true)

    clearWebSessionCloseIntentsForEnvironment(SCOPE.environmentId)
    expect(isPending(sibling, 'tab-b')).toBe(false)
    expect(isPending(otherHost, 'tab-c', NOW, 'epoch-b')).toBe(true)
  })
})
