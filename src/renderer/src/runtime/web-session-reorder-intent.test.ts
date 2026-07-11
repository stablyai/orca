import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_WEB_SESSION_REORDER_INTENT_SCOPES,
  MAX_WEB_SESSION_REORDER_INTENTS_PER_SCOPE,
  clearWebSessionReorderIntent,
  clearWebSessionReorderIntentsForEnvironment,
  clearWebSessionReorderIntentsForWorktree,
  getWebSessionReorderIntentCountsForTests,
  recordWebSessionReorderIntent,
  resetWebSessionReorderIntentForTests,
  resolveWebSessionReorderedOrder
} from './web-session-reorder-intent'
import type { WebSessionIntentScope } from './web-session-intent-scope'

const SCOPE = { environmentId: 'env-a', worktreeId: 'repo::/wt' }
const EPOCH = 'host-generation-a'
const NOW = 1_000

afterEach(() => resetWebSessionReorderIntentForTests())

function scope(environmentId: string, worktreeId: string): WebSessionIntentScope {
  return { environmentId, worktreeId }
}

function resolve(
  intentScope: WebSessionIntentScope,
  groupId: string,
  hostOrder: string[],
  now = NOW,
  epoch = EPOCH
): string[] {
  return resolveWebSessionReorderedOrder(intentScope, groupId, hostOrder, now, epoch)
}

describe('web session reorder intent', () => {
  it('survives a slow reconnect longer than ten seconds', () => {
    recordWebSessionReorderIntent(SCOPE, 'group-1', ['tab-b', 'tab-a'], NOW, EPOCH)

    expect(resolve(SCOPE, 'group-1', ['tab-a', 'tab-b'], NOW + 120_000, EPOCH)).toEqual([
      'tab-b',
      'tab-a'
    ])
  })

  it('isolates identical worktree, group, and tab ids across hosts and generations', () => {
    const otherHost = scope('env-b', SCOPE.worktreeId)
    recordWebSessionReorderIntent(SCOPE, 'group-1', ['tab-b', 'tab-a'], NOW, EPOCH)
    recordWebSessionReorderIntent(otherHost, 'group-1', ['tab-a', 'tab-b'], NOW, 'epoch-b')

    expect(resolve(SCOPE, 'group-1', ['tab-a', 'tab-b'], NOW, 'epoch-b')).toEqual([
      'tab-a',
      'tab-b'
    ])
    expect(resolve(SCOPE, 'group-1', ['tab-a', 'tab-b'])).toEqual(['tab-b', 'tab-a'])
    expect(resolve(otherHost, 'group-1', ['tab-b', 'tab-a'], NOW, 'epoch-b')).toEqual([
      'tab-a',
      'tab-b'
    ])
  })

  it('suppresses a late pre-move frame after success and concurrent epoch advances', () => {
    recordWebSessionReorderIntent(SCOPE, 'group-1', ['tab-b', 'tab-a'], NOW, 'before-move')

    expect(resolve(SCOPE, 'group-1', ['tab-b', 'tab-a'], NOW + 1, 'move-success')).toEqual([
      'tab-b',
      'tab-a'
    ])
    expect(resolve(SCOPE, 'group-1', ['tab-b', 'tab-a'], NOW + 2, 'concurrent-newer')).toEqual([
      'tab-b',
      'tab-a'
    ])
    expect(resolve(SCOPE, 'group-1', ['tab-a', 'tab-b'], NOW + 3, 'before-move')).toEqual([
      'tab-b',
      'tab-a'
    ])
    expect(resolve(SCOPE, 'group-1', ['tab-a', 'tab-b'], NOW + 120_000, 'before-move')).toEqual([
      'tab-b',
      'tab-a'
    ])
  })

  it('does not let an older failed RPC clear a newer retry', () => {
    const older = recordWebSessionReorderIntent(SCOPE, 'group-1', ['tab-b', 'tab-a'], NOW, EPOCH)
    const newer = recordWebSessionReorderIntent(
      SCOPE,
      'group-1',
      ['tab-c', 'tab-a'],
      NOW + 1,
      EPOCH
    )
    expect(older).not.toBeNull()
    expect(newer).not.toBeNull()

    clearWebSessionReorderIntent(SCOPE, 'group-1', older!)

    expect(resolve(SCOPE, 'group-1', ['tab-a', 'tab-c'], NOW + 1)).toEqual(['tab-c', 'tab-a'])
  })

  it('clears only the current retry when the newer RPC fails first', () => {
    recordWebSessionReorderIntent(SCOPE, 'group-1', ['tab-b', 'tab-a'], NOW, EPOCH)
    const newer = recordWebSessionReorderIntent(
      SCOPE,
      'group-1',
      ['tab-c', 'tab-a'],
      NOW + 1,
      EPOCH
    )

    clearWebSessionReorderIntent(SCOPE, 'group-1', newer!)

    expect(resolve(SCOPE, 'group-1', ['tab-a', 'tab-c'], NOW + 1)).toEqual(['tab-a', 'tab-c'])
  })

  it('bounds 10k group intents inside one scope', () => {
    for (let i = 0; i < 10_000; i += 1) {
      recordWebSessionReorderIntent(SCOPE, `group-${i}`, ['tab-b', 'tab-a'], NOW, EPOCH)
    }

    expect(getWebSessionReorderIntentCountsForTests()).toEqual({
      scopes: 1,
      groups: MAX_WEB_SESSION_REORDER_INTENTS_PER_SCOPE
    })
    expect(resolve(SCOPE, 'group-0', ['tab-a', 'tab-b'])).toEqual(['tab-a', 'tab-b'])
    expect(resolve(SCOPE, 'group-9999', ['tab-a', 'tab-b'])).toEqual(['tab-b', 'tab-a'])
  })

  it('bounds 10k host-worktree scopes', () => {
    for (let i = 0; i < 10_000; i += 1) {
      recordWebSessionReorderIntent(
        scope(`env-${i}`, `worktree-${i}`),
        'group-1',
        ['tab-b', 'tab-a'],
        NOW,
        `epoch-${i}`
      )
    }

    expect(getWebSessionReorderIntentCountsForTests()).toEqual({
      scopes: MAX_WEB_SESSION_REORDER_INTENT_SCOPES,
      groups: MAX_WEB_SESSION_REORDER_INTENT_SCOPES
    })
    expect(
      resolve(scope('env-0', 'worktree-0'), 'group-1', ['tab-a', 'tab-b'], NOW, 'epoch-0')
    ).toEqual(['tab-a', 'tab-b'])
  })

  it('clears one worktree or environment without touching another host', () => {
    const sibling = scope(SCOPE.environmentId, 'repo::/sibling')
    const otherHost = scope('env-b', SCOPE.worktreeId)
    recordWebSessionReorderIntent(SCOPE, 'group-1', ['b', 'a'], NOW, EPOCH)
    recordWebSessionReorderIntent(sibling, 'group-1', ['d', 'c'], NOW, EPOCH)
    recordWebSessionReorderIntent(otherHost, 'group-1', ['f', 'e'], NOW, 'epoch-b')

    clearWebSessionReorderIntentsForWorktree(SCOPE)
    expect(resolve(SCOPE, 'group-1', ['a', 'b'])).toEqual(['a', 'b'])
    expect(resolve(sibling, 'group-1', ['c', 'd'])).toEqual(['d', 'c'])

    clearWebSessionReorderIntentsForEnvironment(SCOPE.environmentId)
    expect(resolve(sibling, 'group-1', ['c', 'd'])).toEqual(['c', 'd'])
    expect(resolve(otherHost, 'group-1', ['e', 'f'], NOW, 'epoch-b')).toEqual(['f', 'e'])
  })
})
