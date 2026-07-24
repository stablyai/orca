import { describe, expect, it } from 'vitest'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext
} from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/types'
import {
  EMPTY_WORKTREE_AGENT_ORCHESTRATION,
  selectRuntimeAgentOrchestrationBatch
} from './worktree-agent-orchestration-batch'
import { selectRuntimeAgentOrchestrationForWorktree } from './worktree-agent-row-selectors'

type BatchState = Parameters<typeof selectRuntimeAgentOrchestrationBatch>[0]

const CHILD_KEY = makePaneKey('tab-child', '11111111-1111-4111-8111-111111111111')
const SECOND_CHILD_KEY = makePaneKey('tab-child', '22222222-2222-4222-8222-222222222222')
const ORPHAN_KEY = makePaneKey('tab-orphan', '33333333-3333-4333-8333-333333333333')
const PARENT_KEY = makePaneKey('tab-parent', '44444444-4444-4444-8444-444444444444')
const MALFORMED_KEY = makePaneKey('tab-none', '55555555-5555-4555-8555-555555555555')
const DIFFERENT_STORE_KEY = makePaneKey('tab-other', '66666666-6666-4666-8666-666666666666')
const LEGACY_KEY = 'tab-legacy:1'

function makeTab(id: string, worktreeId = 'stored-worktree-id'): TerminalTab {
  return {
    id,
    worktreeId,
    ptyId: null,
    title: 'shell',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeCountedTab(id: string, onIdRead: () => void): TerminalTab {
  const tab = makeTab(id)
  Object.defineProperty(tab, 'id', {
    enumerable: true,
    get: () => {
      onIdRead()
      return id
    }
  })
  return tab
}

function makeEntry(mapKey: string, worktreeId: string, entryPaneKey = mapKey): AgentStatusEntry {
  return {
    paneKey: entryPaneKey,
    state: 'working',
    stateStartedAt: 1,
    updatedAt: 1,
    stateHistory: [],
    prompt: 'working',
    agentType: 'claude',
    worktreeId
  }
}

function makeRetained(mapKey: string, worktreeId: string): RetainedAgentEntry {
  return {
    entry: makeEntry(mapKey, worktreeId),
    worktreeId,
    tab: makeTab('retained-tab'),
    agentType: 'claude',
    startedAt: 1
  }
}

function makeContext(
  taskId: string,
  overrides: Partial<AgentStatusOrchestrationContext> = {}
): AgentStatusOrchestrationContext {
  return {
    taskId,
    dispatchId: `dispatch-${taskId}`,
    ...overrides
  }
}

function getBatchRecord(
  batch: ReadonlyMap<string, Record<string, AgentStatusOrchestrationContext>>,
  worktreeId: string
): Record<string, AgentStatusOrchestrationContext> {
  return batch.get(worktreeId) ?? EMPTY_WORKTREE_AGENT_ORCHESTRATION
}

function expectReferenceParity(state: BatchState, worktreeIds: string[]): void {
  const batch = selectRuntimeAgentOrchestrationBatch(state, worktreeIds)
  for (const worktreeId of new Set(worktreeIds)) {
    const expected = selectRuntimeAgentOrchestrationForWorktree(state, worktreeId)
    const actual = getBatchRecord(batch, worktreeId)
    expect(Object.keys(actual)).toEqual(Object.keys(expected))
    for (const paneKey of Object.keys(expected)) {
      expect(actual[paneKey]).toBe(expected[paneKey])
    }
  }
}

describe('selectRuntimeAgentOrchestrationBatch', () => {
  it('short-circuits empty requests and empty runtime before reading unrelated slices', () => {
    let forbiddenAccesses = 0
    const noRequestsState = {
      get runtimeAgentOrchestrationByPaneKey() {
        forbiddenAccesses += 1
        throw new Error('runtime must stay cold')
      },
      get tabsByWorktree() {
        forbiddenAccesses += 1
        throw new Error('tabs must stay cold')
      }
    } as unknown as BatchState
    const noRequests = selectRuntimeAgentOrchestrationBatch(noRequestsState, [])

    const emptyRuntimeState = {
      runtimeAgentOrchestrationByPaneKey: {},
      get tabsByWorktree() {
        forbiddenAccesses += 1
        throw new Error('tabs must stay cold')
      },
      get agentStatusByPaneKey() {
        forbiddenAccesses += 1
        throw new Error('live status must stay cold')
      },
      get retainedAgentsByPaneKey() {
        forbiddenAccesses += 1
        throw new Error('retained status must stay cold')
      }
    } as unknown as BatchState
    const emptyRuntime = selectRuntimeAgentOrchestrationBatch(emptyRuntimeState, ['target'])

    expect(noRequests).toBe(emptyRuntime)
    expect(emptyRuntime.size).toBe(0)
    expect(forbiddenAccesses).toBe(0)
  })

  it('matches the per-worktree selector across every attribution path and runtime order', () => {
    const childContext = makeContext('child')
    const secondChildContext = makeContext('second-child')
    const parentContext = makeContext('parent', { parentPaneKey: PARENT_KEY })
    const legacyContext = makeContext('legacy', { parentPaneKey: 'tab-parent:7' })
    const malformedContext = makeContext('malformed', { parentPaneKey: 'bad:parent:key' })
    const state = {
      tabsByWorktree: {
        'wt-child': [makeTab('tab-child'), makeTab('tab-child')],
        'wt-child-copy': [makeTab('tab-child')],
        'wt-orphan': [makeTab('tab-orphan')],
        'wt-parent': [makeTab('tab-parent')],
        'wt-legacy': [makeTab('tab-legacy')],
        'wt-empty-tab': [makeTab('')],
        'wt-unrelated-null': null
      } as unknown as BatchState['tabsByWorktree'],
      runtimeAgentOrchestrationByPaneKey: {
        [CHILD_KEY]: childContext,
        [SECOND_CHILD_KEY]: secondChildContext,
        [ORPHAN_KEY]: parentContext,
        [LEGACY_KEY]: legacyContext,
        [MALFORMED_KEY]: malformedContext
      },
      agentStatusByPaneKey: {
        [CHILD_KEY]: {
          ...makeEntry(CHILD_KEY, 'wt-live', DIFFERENT_STORE_KEY),
          orchestration: makeContext('live-is-not-the-value-domain')
        },
        [LEGACY_KEY]: makeEntry(LEGACY_KEY, 'wt-legacy-exact'),
        [MALFORMED_KEY]: makeEntry(MALFORMED_KEY, ''),
        [DIFFERENT_STORE_KEY]: makeEntry(DIFFERENT_STORE_KEY, 'wt-must-not-appear', ORPHAN_KEY)
      },
      retainedAgentsByPaneKey: {
        [CHILD_KEY]: makeRetained(CHILD_KEY, 'wt-retained')
      }
    } as BatchState
    const requested = [
      'wt-child',
      'wt-child',
      'wt-child-copy',
      'wt-orphan',
      'wt-parent',
      'wt-legacy',
      'wt-empty-tab',
      'wt-legacy-exact',
      'wt-live',
      'wt-retained',
      '',
      'wt-must-not-appear',
      'wt-unrelated-null',
      'missing'
    ]

    expectReferenceParity(state, requested)
    const batch = selectRuntimeAgentOrchestrationBatch(state, requested)
    expect(Object.keys(getBatchRecord(batch, 'wt-child'))).toEqual([CHILD_KEY, SECOND_CHILD_KEY])
    expect(getBatchRecord(batch, 'wt-parent')[ORPHAN_KEY]).toBe(parentContext)
    expect(getBatchRecord(batch, 'wt-orphan')[ORPHAN_KEY]).toBe(parentContext)
    expect(getBatchRecord(batch, 'wt-live')[CHILD_KEY]).toBe(childContext)
    expect(getBatchRecord(batch, 'wt-retained')[CHILD_KEY]).toBe(childContext)
    expect(getBatchRecord(batch, 'wt-legacy')).toBe(EMPTY_WORKTREE_AGENT_ORCHESTRATION)
    expect(getBatchRecord(batch, 'wt-legacy-exact')[LEGACY_KEY]).toBe(legacyContext)
    expect(getBatchRecord(batch, '')[MALFORMED_KEY]).toBe(malformedContext)
    expect(getBatchRecord(batch, 'wt-must-not-appear')).toBe(EMPTY_WORKTREE_AGENT_ORCHESTRATION)
  })

  it('invalidates every source while preserving unchanged ordered bucket identities', () => {
    const firstContext = makeContext('first')
    const secondContext = makeContext('second')
    const otherContext = makeContext('other')
    const otherKey = makePaneKey('tab-other', '77777777-7777-4777-8777-777777777777')
    const baseState = {
      tabsByWorktree: {
        'wt-1': [makeTab('tab-child'), makeTab('unrelated-tab')],
        'wt-2': [makeTab('tab-other')]
      },
      runtimeAgentOrchestrationByPaneKey: {
        [CHILD_KEY]: firstContext,
        [SECOND_CHILD_KEY]: secondContext,
        [otherKey]: otherContext
      },
      agentStatusByPaneKey: {},
      retainedAgentsByPaneKey: {}
    } as BatchState
    const requested = ['wt-1', 'wt-2']
    const firstBatch = selectRuntimeAgentOrchestrationBatch(baseState, requested)
    const firstWt1 = getBatchRecord(firstBatch, 'wt-1')
    const firstWt2 = getBatchRecord(firstBatch, 'wt-2')
    expect(selectRuntimeAgentOrchestrationBatch({ ...baseState }, [...requested])).toBe(firstBatch)

    const reorderedTabs = {
      ...baseState,
      tabsByWorktree: {
        'wt-2': [makeTab('tab-other')],
        'wt-1': [makeTab('unrelated-tab'), makeTab('tab-child')]
      }
    }
    expectReferenceParity(reorderedTabs, requested)
    const reorderedTabBatch = selectRuntimeAgentOrchestrationBatch(reorderedTabs, requested)
    expect(getBatchRecord(reorderedTabBatch, 'wt-1')).toBe(firstWt1)
    expect(getBatchRecord(reorderedTabBatch, 'wt-2')).toBe(firstWt2)

    const liveChurn = {
      ...reorderedTabs,
      agentStatusByPaneKey: { unrelated: makeEntry('unrelated', 'wt-3') }
    }
    const liveBatch = selectRuntimeAgentOrchestrationBatch(liveChurn, requested)
    expect(getBatchRecord(liveBatch, 'wt-1')).toBe(firstWt1)
    expect(getBatchRecord(liveBatch, 'wt-2')).toBe(firstWt2)

    const retainedChurn = {
      ...liveChurn,
      retainedAgentsByPaneKey: { unrelated: makeRetained('unrelated', 'wt-3') }
    }
    const retainedBatch = selectRuntimeAgentOrchestrationBatch(retainedChurn, requested)
    expect(getBatchRecord(retainedBatch, 'wt-1')).toBe(firstWt1)
    expect(getBatchRecord(retainedBatch, 'wt-2')).toBe(firstWt2)

    const reorderedRuntime = {
      ...retainedChurn,
      runtimeAgentOrchestrationByPaneKey: {
        [SECOND_CHILD_KEY]: secondContext,
        [CHILD_KEY]: firstContext,
        [otherKey]: otherContext
      }
    }
    expectReferenceParity(reorderedRuntime, requested)
    const reorderedRuntimeBatch = selectRuntimeAgentOrchestrationBatch(reorderedRuntime, requested)
    const reorderedWt1 = getBatchRecord(reorderedRuntimeBatch, 'wt-1')
    expect(Object.keys(reorderedWt1)).toEqual([SECOND_CHILD_KEY, CHILD_KEY])
    expect(reorderedWt1).not.toBe(firstWt1)
    expect(getBatchRecord(reorderedRuntimeBatch, 'wt-2')).toBe(firstWt2)

    const replacementContext = makeContext('replacement')
    const replacedRuntime = {
      ...reorderedRuntime,
      runtimeAgentOrchestrationByPaneKey: {
        [SECOND_CHILD_KEY]: replacementContext,
        [CHILD_KEY]: firstContext,
        [otherKey]: otherContext
      }
    }
    const replacedBatch = selectRuntimeAgentOrchestrationBatch(replacedRuntime, requested)
    expect(getBatchRecord(replacedBatch, 'wt-1')).not.toBe(reorderedWt1)
    expect(getBatchRecord(replacedBatch, 'wt-1')[SECOND_CHILD_KEY]).toBe(replacementContext)
    expect(getBatchRecord(replacedBatch, 'wt-2')).toBe(firstWt2)
  })

  it('releases raw and derived caches for empty requests and empty runtime', () => {
    let tabIdReads = 0
    const state = {
      tabsByWorktree: {
        target: [
          makeCountedTab('tab-child', () => {
            tabIdReads += 1
          })
        ]
      },
      runtimeAgentOrchestrationByPaneKey: {
        [CHILD_KEY]: makeContext('child')
      },
      agentStatusByPaneKey: {},
      retainedAgentsByPaneKey: {}
    } as BatchState

    const first = getBatchRecord(selectRuntimeAgentOrchestrationBatch(state, ['target']), 'target')
    expect(tabIdReads).toBe(1)

    selectRuntimeAgentOrchestrationBatch(state, [])
    const afterEmptyRequest = getBatchRecord(
      selectRuntimeAgentOrchestrationBatch(state, ['target']),
      'target'
    )
    expect(tabIdReads).toBe(2)
    expect(afterEmptyRequest).not.toBe(first)

    selectRuntimeAgentOrchestrationBatch({ ...state, runtimeAgentOrchestrationByPaneKey: {} }, [
      'target'
    ])
    const afterEmptyRuntime = getBatchRecord(
      selectRuntimeAgentOrchestrationBatch(state, ['target']),
      'target'
    )
    expect(tabIdReads).toBe(3)
    expect(afterEmptyRuntime).not.toBe(afterEmptyRequest)
  })

  it('keeps singleton tab work target-local', () => {
    const tabCount = 10
    const contextCount = 8
    const makeCountedState = () => {
      let runtimeEnumerations = 0
      let runtimeValueReads = 0
      let contextVisits = 0
      let targetTabIdReads = 0
      let unrelatedTabIdReads = 0
      const rawRuntime: Record<string, AgentStatusOrchestrationContext> = {}
      for (let index = 0; index < contextCount; index += 1) {
        const paneKey = makePaneKey(
          'tab-target',
          `88888888-8888-4888-8888-${index.toString(16).padStart(12, '0')}`
        )
        rawRuntime[paneKey] = {
          taskId: `task-${index}`,
          dispatchId: `dispatch-${index}`,
          get parentPaneKey() {
            contextVisits += 1
            return undefined
          }
        }
      }
      const runtime = new Proxy(rawRuntime, {
        ownKeys(target) {
          runtimeEnumerations += 1
          return Reflect.ownKeys(target)
        },
        get(target, key, receiver) {
          if (typeof key === 'string' && Object.hasOwn(target, key)) {
            runtimeValueReads += 1
          }
          return Reflect.get(target, key, receiver)
        }
      })
      const tabsByWorktree = Object.fromEntries(
        Array.from({ length: tabCount }, (_, index) => {
          const isTarget = index === 0
          return [
            isTarget ? 'target' : `unrelated-${index}`,
            [
              makeCountedTab(isTarget ? 'tab-target' : `tab-unrelated-${index}`, () => {
                if (isTarget) {
                  targetTabIdReads += 1
                } else {
                  unrelatedTabIdReads += 1
                }
              })
            ]
          ]
        })
      )
      return {
        state: {
          tabsByWorktree,
          runtimeAgentOrchestrationByPaneKey: runtime,
          agentStatusByPaneKey: {},
          retainedAgentsByPaneKey: {}
        } as BatchState,
        counts: () => ({
          runtimeEnumerations,
          runtimeValueReads,
          contextVisits,
          targetTabIdReads,
          unrelatedTabIdReads
        })
      }
    }
    const reference = makeCountedState()
    const batched = makeCountedState()

    const expected = selectRuntimeAgentOrchestrationForWorktree(reference.state, 'target')
    const actual = getBatchRecord(
      selectRuntimeAgentOrchestrationBatch(batched.state, ['target']),
      'target'
    )

    expect(Object.keys(actual)).toEqual(Object.keys(expected))
    const operationBudget = {
      runtimeEnumerations: 1,
      runtimeValueReads: contextCount,
      contextVisits: contextCount,
      targetTabIdReads: 1,
      unrelatedTabIdReads: 0
    }
    expect(reference.counts()).toEqual(operationBudget)
    expect(batched.counts()).toEqual(operationBudget)
  })

  it('collapses multi-worktree runtime scans and caches unchanged publications', () => {
    const worktreeCount = 12
    const contextCount = 24
    const publicationCount = 40
    const makeCountedState = () => {
      let runtimeEnumerations = 0
      let runtimeValueReads = 0
      let contextVisits = 0
      let tabIdReads = 0
      const rawRuntime: Record<string, AgentStatusOrchestrationContext> = {}
      for (let index = 0; index < contextCount; index += 1) {
        const paneKey = makePaneKey(
          `tab-${index % worktreeCount}`,
          `99999999-9999-4999-8999-${index.toString(16).padStart(12, '0')}`
        )
        rawRuntime[paneKey] = {
          taskId: `task-${index}`,
          dispatchId: `dispatch-${index}`,
          get parentPaneKey() {
            contextVisits += 1
            return undefined
          }
        }
      }
      const runtime = new Proxy(rawRuntime, {
        ownKeys(target) {
          runtimeEnumerations += 1
          return Reflect.ownKeys(target)
        },
        get(target, key, receiver) {
          if (typeof key === 'string' && Object.hasOwn(target, key)) {
            runtimeValueReads += 1
          }
          return Reflect.get(target, key, receiver)
        }
      })
      return {
        state: {
          tabsByWorktree: Object.fromEntries(
            Array.from({ length: worktreeCount }, (_, index) => [
              `wt-${index}`,
              [
                makeCountedTab(`tab-${index}`, () => {
                  tabIdReads += 1
                })
              ]
            ])
          ),
          runtimeAgentOrchestrationByPaneKey: runtime,
          agentStatusByPaneKey: {},
          retainedAgentsByPaneKey: {}
        } as BatchState,
        counts: () => ({ runtimeEnumerations, runtimeValueReads, contextVisits, tabIdReads })
      }
    }
    const requested = Array.from({ length: worktreeCount }, (_, index) => `wt-${index}`)
    const reference = makeCountedState()
    const batched = makeCountedState()

    for (const worktreeId of requested) {
      selectRuntimeAgentOrchestrationForWorktree(reference.state, worktreeId)
    }
    selectRuntimeAgentOrchestrationBatch(batched.state, requested)

    expect(reference.counts()).toEqual({
      runtimeEnumerations: worktreeCount,
      runtimeValueReads: worktreeCount * contextCount,
      contextVisits: worktreeCount * contextCount,
      tabIdReads: worktreeCount
    })
    expect(batched.counts()).toEqual({
      runtimeEnumerations: 1,
      runtimeValueReads: contextCount,
      contextVisits: contextCount,
      tabIdReads: worktreeCount
    })

    for (let publication = 0; publication < publicationCount; publication += 1) {
      selectRuntimeAgentOrchestrationBatch({ ...batched.state }, [...requested])
    }
    expect(batched.counts()).toEqual({
      runtimeEnumerations: 1,
      runtimeValueReads: contextCount,
      contextVisits: contextCount,
      tabIdReads: worktreeCount
    })

    for (let publication = 0; publication < publicationCount; publication += 1) {
      selectRuntimeAgentOrchestrationBatch(
        {
          ...batched.state,
          agentStatusByPaneKey: {
            [`unrelated-${publication}`]: makeEntry(`unrelated-${publication}`, 'elsewhere')
          }
        },
        requested
      )
    }
    expect(batched.counts()).toEqual({
      runtimeEnumerations: 1,
      runtimeValueReads: contextCount,
      contextVisits: contextCount * (publicationCount + 1),
      tabIdReads: worktreeCount
    })
  })
})
