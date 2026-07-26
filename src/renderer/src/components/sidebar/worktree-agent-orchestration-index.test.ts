import { beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext
} from '../../../../shared/agent-status-types'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import type { TerminalTab } from '../../../../shared/types'
import { makePaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import {
  EMPTY_WORKTREE_AGENT_ORCHESTRATION,
  releaseWorktreeAgentOrchestrationIndexCache,
  selectWorktreeAgentOrchestration
} from './worktree-agent-orchestration-index'

type IndexState = Parameters<typeof selectWorktreeAgentOrchestration>[0]

const EMPTY_RECORD = {}

// Pane keys that reach this selector unvalidated. `__proto__` is the one whose
// meaning depends on how the output record is built.
const MALFORMED_RUNTIME_KEYS = ['__proto__', 'constructor', 'toString', 'no-colon', 'a:b:c']

// Why not plain assignment: writing `__proto__` onto an object literal hits the
// prototype setter, so the fixture itself would lose the key under test.
function defineKey<T>(map: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(map, key, { value, enumerable: true, writable: true, configurable: true })
}

/**
 * The pre-index per-card selector, transcribed from the revision this index
 * replaced. Kept as the oracle so equivalence is asserted against real prior
 * behavior rather than against a restatement of the new implementation.
 *
 * One deliberate correction: the original accumulated into `{}`, so a pane key
 * of `__proto__` hit the prototype setter and vanished. This builds a
 * null-prototype record so the oracle expresses intended attribution.
 */
function legacySelectForWorktree(
  state: IndexState,
  worktreeId: string
): Record<string, AgentStatusOrchestrationContext> {
  const tabs = (state.tabsByWorktree ?? EMPTY_RECORD)[worktreeId] ?? []
  const tabIds = new Set(tabs.map((tab) => tab.id))
  const out: Record<string, AgentStatusOrchestrationContext> = Object.create(null)
  const runtimeAgentOrchestrationByPaneKey =
    state.runtimeAgentOrchestrationByPaneKey ?? EMPTY_RECORD
  const agentStatusByPaneKey = state.agentStatusByPaneKey ?? EMPTY_RECORD
  const retainedAgentsByPaneKey = state.retainedAgentsByPaneKey ?? EMPTY_RECORD
  for (const [paneKey, orchestration] of Object.entries(runtimeAgentOrchestrationByPaneKey)) {
    const parsed = parsePaneKey(paneKey)
    const parsedParent = orchestration.parentPaneKey
      ? parsePaneKey(orchestration.parentPaneKey)
      : null
    const liveEntry = agentStatusByPaneKey[paneKey]
    const retainedEntry = retainedAgentsByPaneKey[paneKey]
    if (
      (parsed && tabIds.has(parsed.tabId)) ||
      (parsedParent && tabIds.has(parsedParent.tabId)) ||
      liveEntry?.worktreeId === worktreeId ||
      retainedEntry?.worktreeId === worktreeId
    ) {
      out[paneKey] = orchestration
    }
  }
  return out
}

// Why a seeded PRNG: a randomized differential must reproduce exactly when it
// reports a divergence.
function createRandom(seed: number): () => number {
  // Why the multiply: xorshift32 needs a high-entropy state. Seeding it with a
  // small integer keeps the first output under 0.019, so `1 + pick(5)` was 1 for
  // every seed here and the suite only ever built single-worktree stores.
  let state = Math.imul(seed >>> 0 || 1, 0x9e37_79b1) >>> 0 || 1
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >> 17
    state ^= state << 5
    state >>>= 0
    return state / 0x1_00_00_00_00
  }
}

function makeTab(id: string): TerminalTab {
  return {
    id,
    worktreeId: 'unused',
    ptyId: null,
    title: 'Claude',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function paneKeyFor(tabId: string, index: number): string {
  return makePaneKey(tabId, `88888888-8888-4888-8888-${index.toString(16).padStart(12, '0')}`)
}

function makeEntry(paneKey: string, worktreeId: string): AgentStatusEntry {
  return { paneKey, worktreeId, state: 'busy', startedAt: 0 } as unknown as AgentStatusEntry
}

function makeRetained(paneKey: string, worktreeId: string): RetainedAgentEntry {
  return {
    worktreeId,
    entry: makeEntry(paneKey, worktreeId),
    retainedAt: 0
  } as unknown as RetainedAgentEntry
}

describe('selectWorktreeAgentOrchestration', () => {
  beforeEach(() => {
    releaseWorktreeAgentOrchestrationIndexCache()
  })

  it('matches the pre-index per-card selector across randomized stores', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      releaseWorktreeAgentOrchestrationIndexCache()
      const random = createRandom(seed)
      const pick = (limit: number): number => Math.floor(random() * limit)

      const worktreeCount = 1 + pick(5)
      const worktreeIds = Array.from({ length: worktreeCount }, (_, index) => `wt-${index}`)
      const tabsByWorktree: Record<string, TerminalTab[]> = {}
      const tabIds: string[] = []
      for (const worktreeId of worktreeIds) {
        const tabCount = pick(3)
        const tabs: TerminalTab[] = []
        for (let tabIndex = 0; tabIndex < tabCount; tabIndex += 1) {
          // Why a small shared id space: tab ids collide across worktrees on
          // 131 of these 300 seeds, which is the multi-attribution path.
          const tabId = `tab-${pick(4)}`
          tabs.push(makeTab(tabId))
          tabIds.push(tabId)
        }
        tabsByWorktree[worktreeId] = tabs
      }

      const runtimeAgentOrchestrationByPaneKey: Record<string, AgentStatusOrchestrationContext> = {}
      const agentStatusByPaneKey: Record<string, AgentStatusEntry> = {}
      const retainedAgentsByPaneKey: Record<string, RetainedAgentEntry> = {}
      const contextCount = pick(8)
      for (let index = 0; index < contextCount; index += 1) {
        const ownerTabId =
          random() < 0.7 && tabIds.length > 0 ? tabIds[pick(tabIds.length)] : 'tab-orphan'
        // Why malformed runtime keys: a pane key that is not `tab:uuid` reaches
        // this selector unvalidated, and `__proto__` is the one that changes
        // meaning depending on how the output record is built.
        const keyRoll = random()
        const paneKey =
          keyRoll < 0.08
            ? MALFORMED_RUNTIME_KEYS[pick(MALFORMED_RUNTIME_KEYS.length)]
            : paneKeyFor(ownerTabId, index)
        const parentRoll = random()
        const parentPaneKey =
          parentRoll < 0.3 && tabIds.length > 0
            ? paneKeyFor(tabIds[pick(tabIds.length)], 900 + index)
            : parentRoll < 0.4
              ? 'malformed:parent:key'
              : undefined
        defineKey(runtimeAgentOrchestrationByPaneKey, paneKey, {
          taskId: `task-${index}`,
          dispatchId: `dispatch-${index}`,
          ...(parentPaneKey === undefined ? {} : { parentPaneKey })
        })
        if (random() < 0.35) {
          defineKey(
            agentStatusByPaneKey,
            paneKey,
            makeEntry(paneKey, `wt-${pick(worktreeCount + 1)}`)
          )
        }
        if (random() < 0.25) {
          defineKey(
            retainedAgentsByPaneKey,
            paneKey,
            makeRetained(paneKey, `wt-${pick(worktreeCount + 1)}`)
          )
        }
      }

      const state = {
        tabsByWorktree,
        runtimeAgentOrchestrationByPaneKey,
        agentStatusByPaneKey,
        retainedAgentsByPaneKey
      } as unknown as IndexState

      // Why the extra id: worktrees with no tabs are still reachable through a
      // live or retained attribution, and must resolve identically.
      for (const worktreeId of [...worktreeIds, `wt-${worktreeCount}`, 'missing']) {
        const expected = legacySelectForWorktree(state, worktreeId)
        const actual = selectWorktreeAgentOrchestration(state, worktreeId)
        expect(Object.keys(actual), `seed ${seed} / ${worktreeId}`).toEqual(Object.keys(expected))
        for (const paneKey of Object.keys(expected)) {
          expect(actual[paneKey], `seed ${seed} / ${worktreeId} / ${paneKey}`).toBe(
            expected[paneKey]
          )
        }
      }
    }
  })

  it('returns one shared empty record for worktrees with no orchestration', () => {
    const state = {
      tabsByWorktree: { 'wt-1': [makeTab('tab-1')] },
      runtimeAgentOrchestrationByPaneKey: {
        [paneKeyFor('tab-1', 0)]: { taskId: 't', dispatchId: 'd' }
      },
      agentStatusByPaneKey: {},
      retainedAgentsByPaneKey: {}
    } as unknown as IndexState

    expect(selectWorktreeAgentOrchestration(state, 'wt-2')).toBe(EMPTY_WORKTREE_AGENT_ORCHESTRATION)
    expect(selectWorktreeAgentOrchestration(state, 'wt-2')).toBe(
      selectWorktreeAgentOrchestration(state, 'wt-3')
    )
  })

  it('keeps record identity stable across publications that change nothing it reads', () => {
    const context = { taskId: 't', dispatchId: 'd' }
    const base = {
      tabsByWorktree: { 'wt-1': [makeTab('tab-1')] },
      runtimeAgentOrchestrationByPaneKey: { [paneKeyFor('tab-1', 0)]: context },
      agentStatusByPaneKey: {},
      retainedAgentsByPaneKey: {}
    } as unknown as IndexState

    const first = selectWorktreeAgentOrchestration(base, 'wt-1')
    expect(selectWorktreeAgentOrchestration({ ...base } as IndexState, 'wt-1')).toBe(first)

    // Why: a live-status ping for an unrelated pane is the highest-frequency
    // publication in this store, and must not hand cards a new object.
    const liveChurn = {
      ...base,
      agentStatusByPaneKey: { unrelated: makeEntry('unrelated', 'wt-9') }
    } as unknown as IndexState
    expect(selectWorktreeAgentOrchestration(liveChurn, 'wt-1')).toBe(first)

    const retainedChurn = {
      ...liveChurn,
      retainedAgentsByPaneKey: { unrelated: makeRetained('unrelated', 'wt-9') }
    } as unknown as IndexState
    expect(selectWorktreeAgentOrchestration(retainedChurn, 'wt-1')).toBe(first)
  })

  it('rebuilds when a source it reads actually changes', () => {
    const context = { taskId: 't', dispatchId: 'd' }
    const paneKey = paneKeyFor('tab-1', 0)
    const base = {
      tabsByWorktree: { 'wt-1': [makeTab('tab-1')] },
      runtimeAgentOrchestrationByPaneKey: { [paneKey]: context },
      agentStatusByPaneKey: {},
      retainedAgentsByPaneKey: {}
    } as unknown as IndexState
    selectWorktreeAgentOrchestration(base, 'wt-1')

    const replacement = { taskId: 't2', dispatchId: 'd2' }
    const replaced = {
      ...base,
      runtimeAgentOrchestrationByPaneKey: { [paneKey]: replacement }
    } as unknown as IndexState
    expect(selectWorktreeAgentOrchestration(replaced, 'wt-1')[paneKey]).toBe(replacement)

    // Why: moving the tab to another worktree must re-attribute, which only
    // happens if tab membership is keyed on the tabs slice identity.
    const movedTab = {
      ...replaced,
      tabsByWorktree: { 'wt-2': [makeTab('tab-1')] }
    } as unknown as IndexState
    expect(selectWorktreeAgentOrchestration(movedTab, 'wt-1')).toBe(
      EMPTY_WORKTREE_AGENT_ORCHESTRATION
    )
    expect(selectWorktreeAgentOrchestration(movedTab, 'wt-2')[paneKey]).toBe(replacement)
  })

  it('treats a missing or emptied orchestration map as empty without reading other slices', () => {
    let forbiddenReads = 0
    const coldState = {
      runtimeAgentOrchestrationByPaneKey: {},
      get tabsByWorktree() {
        forbiddenReads += 1
        return {}
      },
      get agentStatusByPaneKey() {
        forbiddenReads += 1
        return {}
      },
      get retainedAgentsByPaneKey() {
        forbiddenReads += 1
        return {}
      }
    } as unknown as IndexState

    expect(selectWorktreeAgentOrchestration(coldState, 'wt-1')).toBe(
      EMPTY_WORKTREE_AGENT_ORCHESTRATION
    )
    expect(selectWorktreeAgentOrchestration({} as IndexState, 'wt-1')).toBe(
      EMPTY_WORKTREE_AGENT_ORCHESTRATION
    )
    expect(forbiddenReads).toBe(0)
  })

  it('does not attribute unowned panes to a nullish worktree id', () => {
    const paneKey = paneKeyFor('tab-orphan', 0)
    const state = {
      tabsByWorktree: {},
      runtimeAgentOrchestrationByPaneKey: { [paneKey]: { taskId: 't', dispatchId: 'd' } },
      agentStatusByPaneKey: {},
      retainedAgentsByPaneKey: {}
    } as unknown as IndexState

    // Why asserted despite `worktreeId: string`: the pre-index selector tested
    // `entry?.worktreeId === worktreeId`, so a nullish id matched every pane
    // that had no live/retained entry. This is the one intentional divergence
    // from the oracle — the old result was wrong, not merely different.
    expect(selectWorktreeAgentOrchestration(state, undefined as unknown as string)).toBe(
      EMPTY_WORKTREE_AGENT_ORCHESTRATION
    )
    expect(legacySelectForWorktree(state, undefined as unknown as string)).toHaveProperty(paneKey)
  })

  it('stays correct when two stores interleave through the single cache slot', () => {
    // Why: the cache is one module-level slot, but the sidebar cards and the
    // dashboard snapshot can call in with different state objects. Thrashing may
    // cost a rebuild; it must never return another store's answer.
    const buildState = (suffix: string): IndexState =>
      ({
        tabsByWorktree: { [`wt-${suffix}`]: [makeTab(`tab-${suffix}`)] },
        runtimeAgentOrchestrationByPaneKey: {
          [paneKeyFor(`tab-${suffix}`, 0)]: { taskId: `t-${suffix}`, dispatchId: `d-${suffix}` }
        },
        agentStatusByPaneKey: {},
        retainedAgentsByPaneKey: {}
      }) as unknown as IndexState

    const stateA = buildState('a')
    const stateB = buildState('b')
    for (let round = 0; round < 4; round += 1) {
      for (const [state, suffix] of [
        [stateA, 'a'],
        [stateB, 'b']
      ] as const) {
        expect(Object.keys(selectWorktreeAgentOrchestration(state, `wt-${suffix}`))).toEqual(
          Object.keys(legacySelectForWorktree(state, `wt-${suffix}`))
        )
        // The other store's worktree must never leak through the shared slot.
        const foreign = suffix === 'a' ? 'wt-b' : 'wt-a'
        expect(selectWorktreeAgentOrchestration(state, foreign)).toBe(
          EMPTY_WORKTREE_AGENT_ORCHESTRATION
        )
      }
    }
  })

  it('treats a __proto__ pane key as data instead of a prototype write', () => {
    // Why: writing this key into a normal object silently drops the entry and
    // repoints the record's prototype at the orchestration context.
    const context = { taskId: 't', dispatchId: 'd' }
    const state = {
      tabsByWorktree: {},
      runtimeAgentOrchestrationByPaneKey: Object.fromEntries([['__proto__', context]]),
      agentStatusByPaneKey: Object.fromEntries([['__proto__', makeEntry('__proto__', 'wt-1')]]),
      retainedAgentsByPaneKey: {}
    } as unknown as IndexState

    const record = selectWorktreeAgentOrchestration(state, 'wt-1')
    expect(Object.keys(record)).toEqual(['__proto__'])
    expect(record['__proto__']).toBe(context)
    expect(Object.getPrototypeOf(record)).toBeNull()
  })

  it('keeps the entries cache warm while the orchestration map is empty', () => {
    // Why: the empty map is the common case, so re-enumerating it per card is
    // exactly the per-publication cost this index exists to remove.
    let enumerations = 0
    const runtimeAgentOrchestrationByPaneKey = new Proxy(
      {},
      {
        ownKeys(target) {
          enumerations += 1
          return Reflect.ownKeys(target)
        }
      }
    )
    const state = {
      tabsByWorktree: {},
      runtimeAgentOrchestrationByPaneKey,
      agentStatusByPaneKey: {},
      retainedAgentsByPaneKey: {}
    } as unknown as IndexState

    for (const worktreeId of ['wt-a', 'wt-b', 'wt-c']) {
      expect(selectWorktreeAgentOrchestration(state, worktreeId)).toBe(
        EMPTY_WORKTREE_AGENT_ORCHESTRATION
      )
    }
    expect(enumerations).toBe(1)
  })

  it('never mutates a record already handed to a subscriber', () => {
    // Why: buildIndex fills record objects in place and can hand back a previous
    // build's record. A mounted card holds that object across renders, so a later
    // build writing into it would break React's snapshot contract silently.
    const paneKey = paneKeyFor('tab-1', 0)
    const base = {
      tabsByWorktree: { 'wt-1': [makeTab('tab-1')] },
      runtimeAgentOrchestrationByPaneKey: { [paneKey]: { taskId: 't', dispatchId: 'd' } },
      agentStatusByPaneKey: {},
      retainedAgentsByPaneKey: {}
    } as unknown as IndexState

    const held = selectWorktreeAgentOrchestration(base, 'wt-1')
    const heldKeys = Object.keys(held)

    const secondPaneKey = paneKeyFor('tab-1', 1)
    const grown = {
      ...base,
      runtimeAgentOrchestrationByPaneKey: {
        ...base.runtimeAgentOrchestrationByPaneKey,
        [secondPaneKey]: { taskId: 't2', dispatchId: 'd2' }
      }
    } as unknown as IndexState
    expect(Object.keys(selectWorktreeAgentOrchestration(grown, 'wt-1'))).toHaveLength(2)
    expect(Object.keys(held)).toEqual(heldKeys)
  })
})
