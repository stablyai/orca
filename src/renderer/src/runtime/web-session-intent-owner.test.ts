import { afterEach, describe, expect, it } from 'vitest'
import {
  isWebSessionCloseIntentPending,
  recordWebSessionCloseIntent,
  resetWebSessionCloseIntentForTests
} from './web-session-close-intent'
import {
  peekWebSessionFocusIntent,
  recordWebSessionFocusIntent,
  resetWebSessionFocusIntentForTests
} from './web-session-focus-intent'
import {
  recordWebSessionReorderIntent,
  resetWebSessionReorderIntentForTests,
  resolveWebSessionReorderedOrder
} from './web-session-reorder-intent'

const WORKTREE_ID = 'repo::/worktree'
const OWNER_A = { environmentId: 'env-a', pairingRevision: 1 }
const OWNER_A_REPAIRED = { environmentId: 'env-a', pairingRevision: 2 }
const OWNER_B = { environmentId: 'env-b', pairingRevision: 1 }

afterEach(() => {
  resetWebSessionCloseIntentForTests()
  resetWebSessionFocusIntentForTests()
  resetWebSessionReorderIntentForTests()
})

describe('web session intent ownership', () => {
  it('isolates close intents across runtimes and same-id re-pairs', () => {
    recordWebSessionCloseIntent(OWNER_A, WORKTREE_ID, 'host-tab', 1_000)

    expect(isWebSessionCloseIntentPending(OWNER_A, WORKTREE_ID, 'host-tab', 1_000)).toBe(true)
    expect(isWebSessionCloseIntentPending(OWNER_A_REPAIRED, WORKTREE_ID, 'host-tab', 1_000)).toBe(
      false
    )
    expect(isWebSessionCloseIntentPending(OWNER_B, WORKTREE_ID, 'host-tab', 1_000)).toBe(false)
  })

  it('isolates focus intents across runtimes and same-id re-pairs', () => {
    recordWebSessionFocusIntent(OWNER_A, WORKTREE_ID, 'host-tab')

    expect(peekWebSessionFocusIntent(OWNER_A, WORKTREE_ID)).toEqual({
      hostTabId: 'host-tab'
    })
    expect(peekWebSessionFocusIntent(OWNER_A_REPAIRED, WORKTREE_ID)).toBeNull()
    expect(peekWebSessionFocusIntent(OWNER_B, WORKTREE_ID)).toBeNull()
  })

  it('isolates reorder intents across runtimes and same-id re-pairs', () => {
    recordWebSessionReorderIntent(OWNER_A, WORKTREE_ID, 'group-1', ['tab-b', 'tab-a'], 1_000)

    expect(
      resolveWebSessionReorderedOrder(OWNER_A, WORKTREE_ID, 'group-1', ['tab-a', 'tab-b'], 1_000)
    ).toEqual(['tab-b', 'tab-a'])
    expect(
      resolveWebSessionReorderedOrder(
        OWNER_A_REPAIRED,
        WORKTREE_ID,
        'group-1',
        ['tab-a', 'tab-b'],
        1_000
      )
    ).toEqual(['tab-a', 'tab-b'])
    expect(
      resolveWebSessionReorderedOrder(OWNER_B, WORKTREE_ID, 'group-1', ['tab-a', 'tab-b'], 1_000)
    ).toEqual(['tab-a', 'tab-b'])
  })
})
