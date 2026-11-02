import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_WEB_SESSION_CLOSE_INTENT_PARTITIONS,
  isWebSessionCloseIntentPending,
  recordWebSessionCloseIntent,
  resetWebSessionCloseIntentForTests
} from './web-session-close-intent'
import {
  MAX_WEB_SESSION_FOCUS_INTENTS,
  peekWebSessionFocusIntent,
  clearWebSessionFocusIntentIfMatches,
  recordWebSessionFocusIntent,
  resetWebSessionFocusIntentForTests
} from './web-session-focus-intent'
import {
  MAX_REORDER_INTENT_PARTITIONS,
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
  it('bounds unresolved reorder intent churn', () => {
    for (let index = 0; index < MAX_REORDER_INTENT_PARTITIONS + 4; index += 1) {
      recordWebSessionReorderIntent(
        { environmentId: `env-${index}`, pairingRevision: 1 },
        WORKTREE_ID,
        'group-1',
        ['tab-b', 'tab-a'],
        1_000
      )
    }

    expect(
      resolveWebSessionReorderedOrder(
        { environmentId: 'env-0', pairingRevision: 1 },
        WORKTREE_ID,
        'group-1',
        ['tab-a', 'tab-b'],
        1_000
      )
    ).toEqual(['tab-a', 'tab-b'])
    expect(
      resolveWebSessionReorderedOrder(
        { environmentId: `env-${MAX_REORDER_INTENT_PARTITIONS + 3}`, pairingRevision: 1 },
        WORKTREE_ID,
        'group-1',
        ['tab-a', 'tab-b'],
        1_000
      )
    ).toEqual(['tab-b', 'tab-a'])
  })

  it('isolates close intents across runtimes and same-id re-pairs', () => {
    recordWebSessionCloseIntent(OWNER_A, WORKTREE_ID, 'host-tab', 1_000)

    expect(isWebSessionCloseIntentPending(OWNER_A, WORKTREE_ID, 'host-tab', 1_000)).toBe(true)
    expect(isWebSessionCloseIntentPending(OWNER_A_REPAIRED, WORKTREE_ID, 'host-tab', 1_000)).toBe(
      false
    )
    expect(isWebSessionCloseIntentPending(OWNER_B, WORKTREE_ID, 'host-tab', 1_000)).toBe(false)
  })

  it('bounds close-intent partition churn', () => {
    for (let index = 0; index < MAX_WEB_SESSION_CLOSE_INTENT_PARTITIONS + 4; index += 1) {
      recordWebSessionCloseIntent(
        { environmentId: `env-${index}`, pairingRevision: 1 },
        WORKTREE_ID,
        `host-tab-${index}`,
        1_000
      )
    }

    expect(
      isWebSessionCloseIntentPending(
        { environmentId: 'env-0', pairingRevision: 1 },
        WORKTREE_ID,
        'host-tab-0',
        1_000
      )
    ).toBe(false)
    expect(
      isWebSessionCloseIntentPending(
        { environmentId: `env-${MAX_WEB_SESSION_CLOSE_INTENT_PARTITIONS + 3}`, pairingRevision: 1 },
        WORKTREE_ID,
        `host-tab-${MAX_WEB_SESSION_CLOSE_INTENT_PARTITIONS + 3}`,
        1_000
      )
    ).toBe(true)
  })

  it('isolates focus intents across runtimes and same-id re-pairs', () => {
    recordWebSessionFocusIntent(OWNER_A, WORKTREE_ID, 'host-tab')

    expect(peekWebSessionFocusIntent(OWNER_A, WORKTREE_ID)).toEqual({
      hostTabId: 'host-tab'
    })
    expect(peekWebSessionFocusIntent(OWNER_A_REPAIRED, WORKTREE_ID)).toBeNull()
    expect(peekWebSessionFocusIntent(OWNER_B, WORKTREE_ID)).toBeNull()
  })

  it('bounds unresolved focus intent churn', () => {
    for (let index = 0; index < MAX_WEB_SESSION_FOCUS_INTENTS + 4; index += 1) {
      recordWebSessionFocusIntent(
        { environmentId: `env-${index}`, pairingRevision: 1 },
        WORKTREE_ID,
        `host-tab-${index}`
      )
    }

    expect(
      peekWebSessionFocusIntent({ environmentId: 'env-0', pairingRevision: 1 }, WORKTREE_ID)
    ).toBeNull()
    expect(
      peekWebSessionFocusIntent(
        { environmentId: `env-${MAX_WEB_SESSION_FOCUS_INTENTS + 3}`, pairingRevision: 1 },
        WORKTREE_ID
      )
    ).toEqual({ hostTabId: `host-tab-${MAX_WEB_SESSION_FOCUS_INTENTS + 3}` })
  })

  it('does not let an older failed create clear a newer focus intent', () => {
    recordWebSessionFocusIntent(OWNER_A, WORKTREE_ID, 'agent-session:newer')

    clearWebSessionFocusIntentIfMatches(OWNER_A, WORKTREE_ID, 'agent-session:older')

    expect(peekWebSessionFocusIntent(OWNER_A, WORKTREE_ID)).toEqual({
      hostTabId: 'agent-session:newer'
    })
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
