import { beforeEach, describe, expect, it } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import type { AppState } from '../../store/types'
import {
  createTestStore,
  makeLayout,
  makeTab,
  makeUnifiedTab,
  makeWorktree,
  TEST_REPO
} from '../../store/slices/store-test-helpers'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  agentStatusPaneRoutingIndexCounters,
  createAgentStatusPaneRoutingIndex,
  resetAgentStatusPaneRoutingIndexCounters,
  resolvePaneKeyFromRoutingIndex
} from './agent-status-pane-routing-index'
import { resolvePaneKey } from './agent-status-routing'

const WORKTREE_COUNT = 100
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF_ID = '22222222-2222-4222-8222-222222222222'

function seedLineage(store: ReturnType<typeof createTestStore>): {
  tabsByWorktree: AppState['tabsByWorktree']
  paneKeys: string[]
} {
  const tabsByWorktree: AppState['tabsByWorktree'] = {}
  const unifiedTabsByWorktree: AppState['unifiedTabsByWorktree'] = {}
  const paneKeys: string[] = []
  for (let index = 0; index < WORKTREE_COUNT; index += 1) {
    const worktreeId = `wt-${index}`
    const tabId = `tab-${index}`
    tabsByWorktree[worktreeId] = [makeTab({ id: tabId, worktreeId, title: `Terminal ${index}` })]
    unifiedTabsByWorktree[worktreeId] = [
      makeUnifiedTab({ id: tabId, worktreeId, groupId: `group-${index}`, label: `Label ${index}` })
    ]
    paneKeys.push(makePaneKey(tabId, LEAF_ID))
  }
  store.setState({
    repos: [TEST_REPO],
    worktreesByRepo: {
      [TEST_REPO.id]: Array.from({ length: WORKTREE_COUNT }, (_, index) =>
        makeWorktree({ id: `wt-${index}`, repoId: TEST_REPO.id })
      )
    },
    tabsByWorktree,
    unifiedTabsByWorktree,
    terminalLayoutsByTabId: {}
  } as Partial<AppState>)
  return { tabsByWorktree, paneKeys }
}

describe('agent-status pane routing index memoization', () => {
  beforeEach(() => {
    resetAgentStatusPaneRoutingIndexCounters()
  })

  it('builds the ownership index once while the tab map stays identity-stable', () => {
    const store = createTestStore()
    const { paneKeys } = seedLineage(store)
    resetAgentStatusPaneRoutingIndexCounters()

    // 100 status commits: each replaces the live status map, none replaces the tab map.
    for (let commit = 0; commit < 100; commit += 1) {
      const index = createAgentStatusPaneRoutingIndex(store.getState())
      expect(resolvePaneKeyFromRoutingIndex(index, paneKeys[commit % paneKeys.length]).exists).toBe(
        true
      )
      store.setState({
        agentStatusByPaneKey: { ...store.getState().agentStatusByPaneKey },
        agentStatusEpoch: commit
      } as Partial<AppState>)
    }

    expect(agentStatusPaneRoutingIndexCounters.indexBuilds).toBe(1)
    expect(agentStatusPaneRoutingIndexCounters.tabIndexBuilds).toBe(1)
    expect(agentStatusPaneRoutingIndexCounters.tabVisits).toBe(WORKTREE_COUNT)
    // Only the worktrees actually routed to pay for a unified-label map.
    expect(agentStatusPaneRoutingIndexCounters.unifiedLabelIndexBuilds).toBeLessThanOrEqual(
      paneKeys.length
    )
  })

  it('rebuilds the tab index when the tab map is replaced', () => {
    const store = createTestStore()
    seedLineage(store)
    createAgentStatusPaneRoutingIndex(store.getState())
    resetAgentStatusPaneRoutingIndexCounters()

    store.setState({
      tabsByWorktree: { ...store.getState().tabsByWorktree }
    } as Partial<AppState>)
    createAgentStatusPaneRoutingIndex(store.getState())

    expect(agentStatusPaneRoutingIndexCounters.tabIndexBuilds).toBe(1)
  })

  it('reuses the index across a layout replacement without re-indexing tabs', () => {
    const store = createTestStore()
    seedLineage(store)
    createAgentStatusPaneRoutingIndex(store.getState())
    resetAgentStatusPaneRoutingIndexCounters()

    store.setState({
      terminalLayoutsByTabId: { 'tab-0': makeLayout() }
    } as Partial<AppState>)
    createAgentStatusPaneRoutingIndex(store.getState())

    expect(agentStatusPaneRoutingIndexCounters.indexBuilds).toBe(1)
    expect(agentStatusPaneRoutingIndexCounters.tabIndexBuilds).toBe(0)
  })
})

describe('agent-status leading-edge and batched pane resolution', () => {
  it('agrees with the standalone resolver across duplicates, splits and missing owners', () => {
    const store = createTestStore()
    const duplicateTabId = 'tab-duplicate'
    const splitTabId = 'tab-split'
    const orphanTabId = 'tab-orphan'
    const unifiedTabsByWorktree: AppState['unifiedTabsByWorktree'] = {
      'wt-a': [
        makeUnifiedTab({
          id: duplicateTabId,
          worktreeId: 'wt-a',
          groupId: 'group-a',
          label: 'First label'
        }),
        makeUnifiedTab({
          id: duplicateTabId,
          worktreeId: 'wt-a',
          groupId: 'group-a',
          label: 'Shadowed label'
        }),
        {
          ...makeUnifiedTab({
            id: splitTabId,
            worktreeId: 'wt-a',
            groupId: 'group-a',
            label: '   '
          })
        } as Tab
      ],
      'wt-b': [
        makeUnifiedTab({
          id: duplicateTabId,
          worktreeId: 'wt-b',
          groupId: 'group-b',
          label: 'Second worktree label'
        })
      ]
    }
    store.setState({
      repos: [TEST_REPO],
      worktreesByRepo: {
        [TEST_REPO.id]: [
          makeWorktree({ id: 'wt-a', repoId: TEST_REPO.id }),
          makeWorktree({ id: 'wt-b', repoId: TEST_REPO.id })
        ]
      },
      tabsByWorktree: {
        'wt-a': [
          makeTab({ id: duplicateTabId, worktreeId: 'wt-a', title: 'Owner A' }),
          makeTab({ id: splitTabId, worktreeId: 'wt-a', title: 'Split owner' })
        ],
        // The same tab id under a second worktree: first worktree must keep ownership.
        'wt-b': [makeTab({ id: duplicateTabId, worktreeId: 'wt-b', title: 'Owner B' })],
        'wt-missing': [makeTab({ id: orphanTabId, worktreeId: 'wt-missing', title: 'Orphan' })]
      },
      unifiedTabsByWorktree,
      terminalLayoutsByTabId: {
        [splitTabId]: {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: LEAF_ID },
            second: { type: 'leaf', leafId: OTHER_LEAF_ID }
          },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          titlesByLeafId: { [LEAF_ID]: 'Pane title', [OTHER_LEAF_ID]: '' }
        }
      }
    } as Partial<AppState>)

    const corpus = [
      makePaneKey(duplicateTabId, LEAF_ID),
      makePaneKey(duplicateTabId, OTHER_LEAF_ID),
      makePaneKey(splitTabId, LEAF_ID),
      makePaneKey(splitTabId, OTHER_LEAF_ID),
      makePaneKey(splitTabId, '33333333-3333-4333-8333-333333333333'),
      makePaneKey(orphanTabId, LEAF_ID),
      makePaneKey('tab-unknown', LEAF_ID),
      'not-a-pane-key'
    ]

    const state = store.getState()
    const index = createAgentStatusPaneRoutingIndex(state)
    for (const paneKey of corpus) {
      expect({ paneKey, ...resolvePaneKeyFromRoutingIndex(index, paneKey) }).toEqual({
        paneKey,
        ...resolvePaneKey(state, paneKey)
      })
    }
  })
})
