import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_WEB_SESSION_FOCUS_INTENT_SCOPES,
  beginWebSessionFocusIntent,
  clearWebSessionFocusIntent,
  clearWebSessionFocusIntentsForEnvironment,
  completeWebSessionFocusIntent,
  consumeWebSessionFocusIntent,
  getWebSessionFocusIntentCountForTests,
  peekWebSessionFocusIntent,
  recordWebSessionFocusIntent,
  resetWebSessionFocusIntentForTests
} from './web-session-focus-intent'
import {
  MAX_WEB_SESSION_PUBLICATION_EPOCH_SCOPES,
  MAX_WEB_SESSION_PUBLICATION_EPOCHS_PER_SCOPE,
  getWebSessionPublicationEpoch,
  getWebSessionPublicationEpochCountForTests,
  getWebSessionPublicationEpochEntryCountForTests,
  rememberWebSessionPublicationEpoch,
  resetWebSessionPublicationEpochsForTests,
  type WebSessionIntentScope
} from './web-session-intent-scope'

const SCOPE = { environmentId: 'env-a', worktreeId: 'repo::/wt' }
const EPOCH = 'host-generation-a'

afterEach(() => {
  resetWebSessionFocusIntentForTests()
  resetWebSessionPublicationEpochsForTests()
})

function scope(environmentId: string, worktreeId: string): WebSessionIntentScope {
  return { environmentId, worktreeId }
}

describe('web session focus intent', () => {
  it('survives a reconnect longer than sixty seconds in the same host generation', () => {
    recordWebSessionFocusIntent(SCOPE, 'host-tab-1', EPOCH)

    expect(peekWebSessionFocusIntent(SCOPE, EPOCH)).toBe('host-tab-1')
  })

  it('isolates identical worktree and tab ids across runtime hosts', () => {
    const otherHost = scope('env-b', SCOPE.worktreeId)
    recordWebSessionFocusIntent(SCOPE, 'same-tab', EPOCH)
    recordWebSessionFocusIntent(otherHost, 'same-tab', 'host-generation-b')

    expect(peekWebSessionFocusIntent(SCOPE, EPOCH)).toBe('same-tab')
    expect(peekWebSessionFocusIntent(otherHost, 'host-generation-b')).toBe('same-tab')
  })

  it('never applies an old host generation to a restarted host with reused ids', () => {
    recordWebSessionFocusIntent(SCOPE, 'reused-tab', EPOCH)

    expect(peekWebSessionFocusIntent(SCOPE, 'host-generation-b')).toBeNull()
    expect(peekWebSessionFocusIntent(SCOPE, EPOCH)).toBe('reused-tab')
  })

  it('uses the owning RPC response epoch when a successful mutation advances it', () => {
    const token = beginWebSessionFocusIntent(SCOPE, 'before-mutation')
    completeWebSessionFocusIntent(SCOPE, token!, 'host-tab-1', 'owning-result')

    expect(consumeWebSessionFocusIntent(SCOPE, 'before-mutation', new Set(['host-tab-1']))).toBe(
      false
    )
    expect(consumeWebSessionFocusIntent(SCOPE, 'owning-result', new Set(['host-tab-1']))).toBe(true)
  })

  it('does not bind an unowned browser result to unrelated late frames', () => {
    const token = beginWebSessionFocusIntent(SCOPE, null)
    completeWebSessionFocusIntent(SCOPE, token!, 'new-browser-page')

    expect(consumeWebSessionFocusIntent(SCOPE, 'stale-before', new Set(['old-tab']))).toBe(false)
    expect(consumeWebSessionFocusIntent(SCOPE, 'concurrent-newer', new Set(['other-tab']))).toBe(
      false
    )
    expect(
      consumeWebSessionFocusIntent(SCOPE, 'owning-result', new Set(['new-browser-page']))
    ).toBe(true)
  })

  it('clears an unbound browser create intent on environment disposal', () => {
    const token = beginWebSessionFocusIntent(SCOPE, null)
    completeWebSessionFocusIntent(SCOPE, token!, 'new-browser-page')

    clearWebSessionFocusIntentsForEnvironment(SCOPE.environmentId)

    expect(getWebSessionFocusIntentCountForTests()).toBe(0)
    expect(
      consumeWebSessionFocusIntent(SCOPE, 'owning-result', new Set(['new-browser-page']))
    ).toBe(false)
  })

  it('ignores a late older create result after a newer focus operation completes', () => {
    const older = beginWebSessionFocusIntent(SCOPE, EPOCH)
    const newer = beginWebSessionFocusIntent(SCOPE, EPOCH)
    expect(older).not.toBeNull()
    expect(newer).not.toBeNull()

    expect(completeWebSessionFocusIntent(SCOPE, newer!, 'new-tab')).toBe(true)
    expect(completeWebSessionFocusIntent(SCOPE, older!, 'old-tab')).toBe(false)
    expect(peekWebSessionFocusIntent(SCOPE, EPOCH)).toBe('new-tab')
  })

  it('ignores an older result even when it arrives before the newer result', () => {
    const older = beginWebSessionFocusIntent(SCOPE, EPOCH)
    const newer = beginWebSessionFocusIntent(SCOPE, EPOCH)

    expect(completeWebSessionFocusIntent(SCOPE, older!, 'old-tab')).toBe(false)
    expect(completeWebSessionFocusIntent(SCOPE, newer!, 'new-tab')).toBe(true)
    expect(peekWebSessionFocusIntent(SCOPE, EPOCH)).toBe('new-tab')
  })

  it('bounds 10k host-worktree scopes while retaining recently reused scopes', () => {
    recordWebSessionFocusIntent(SCOPE, 'keep-tab', EPOCH)
    for (let i = 0; i < 10_000; i += 1) {
      recordWebSessionFocusIntent(scope(`env-${i}`, `worktree-${i}`), `tab-${i}`, `epoch-${i}`)
    }

    expect(getWebSessionFocusIntentCountForTests()).toBe(MAX_WEB_SESSION_FOCUS_INTENT_SCOPES)
    expect(peekWebSessionFocusIntent(scope('env-0', 'worktree-0'), 'epoch-0')).toBeNull()
    expect(peekWebSessionFocusIntent(scope('env-9999', 'worktree-9999'), 'epoch-9999')).toBe(
      'tab-9999'
    )
  })

  it('bounds 10k remembered host publication generations', () => {
    for (let i = 0; i < 10_000; i += 1) {
      rememberWebSessionPublicationEpoch(scope(`env-${i}`, `worktree-${i}`), `epoch-${i}`)
    }

    expect(getWebSessionPublicationEpochCountForTests()).toBe(
      MAX_WEB_SESSION_PUBLICATION_EPOCH_SCOPES
    )
    expect(getWebSessionPublicationEpoch(scope('env-0', 'worktree-0'))).toBeNull()
    expect(getWebSessionPublicationEpoch(scope('env-9999', 'worktree-9999'))).toBe('epoch-9999')
  })

  it('does not roll action ownership back to a previously observed late epoch', () => {
    rememberWebSessionPublicationEpoch(SCOPE, 'before-mutation')
    rememberWebSessionPublicationEpoch(SCOPE, 'after-mutation')
    rememberWebSessionPublicationEpoch(SCOPE, 'before-mutation')

    expect(getWebSessionPublicationEpoch(SCOPE)).toBe('after-mutation')
  })

  it('bounds 10k publication epochs remembered inside one scope', () => {
    for (let i = 0; i < 10_000; i += 1) {
      rememberWebSessionPublicationEpoch(SCOPE, `epoch-${i}`)
    }

    expect(getWebSessionPublicationEpochCountForTests()).toBe(1)
    expect(getWebSessionPublicationEpochEntryCountForTests()).toBe(
      MAX_WEB_SESSION_PUBLICATION_EPOCHS_PER_SCOPE
    )
    rememberWebSessionPublicationEpoch(SCOPE, 'epoch-9999')
    expect(getWebSessionPublicationEpoch(SCOPE)).toBe('epoch-9999')
  })

  it('clears one worktree or one environment without touching another host', () => {
    const sibling = scope(SCOPE.environmentId, 'repo::/sibling')
    const otherHost = scope('env-b', SCOPE.worktreeId)
    recordWebSessionFocusIntent(SCOPE, 'tab-a', EPOCH)
    recordWebSessionFocusIntent(sibling, 'tab-b', EPOCH)
    recordWebSessionFocusIntent(otherHost, 'tab-c', 'epoch-b')

    clearWebSessionFocusIntent(SCOPE)
    expect(peekWebSessionFocusIntent(SCOPE, EPOCH)).toBeNull()
    expect(peekWebSessionFocusIntent(sibling, EPOCH)).toBe('tab-b')

    clearWebSessionFocusIntentsForEnvironment(SCOPE.environmentId)
    expect(peekWebSessionFocusIntent(sibling, EPOCH)).toBeNull()
    expect(peekWebSessionFocusIntent(otherHost, 'epoch-b')).toBe('tab-c')
  })
})
