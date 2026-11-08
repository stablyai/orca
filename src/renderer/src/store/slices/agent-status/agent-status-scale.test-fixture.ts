import { tmpdir } from 'node:os'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { makeTab } from '@/store/terminals/terminal-tab.test-fixture'
import { makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { getDefaultSettings } from '../../../../../shared/constants'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

export function buildAgentStatusScaleFixture(
  onTabVisit: (() => void) | undefined = undefined,
  worktreeCount = 423
) {
  /** Tab list whose iteration is observable, so the nested-loop resolver's comparisons are countable. */
  class CountingTabList<T> extends Array<T> {
    [Symbol.iterator](): ArrayIterator<T> {
      const iterator = super[Symbol.iterator]()
      const next = iterator.next.bind(iterator)
      iterator.next = (...args) => {
        const result = next(...args)
        if (!result.done) {
          onTabVisit?.()
        }
        return result
      }
      return iterator
    }
  }

  const store = createTestStore()
  const settings = store.getState().settings ?? getDefaultSettings(tmpdir())
  const tabsByWorktree: AppState['tabsByWorktree'] = {}
  const unifiedTabsByWorktree: AppState['unifiedTabsByWorktree'] = {}
  const worktrees: ReturnType<typeof makeWorktree>[] = []
  const paneKeys: string[] = []
  const owners: { tabId: string; worktreeId: string }[] = []
  for (let index = 0; index < worktreeCount; index += 1) {
    const worktreeId = `wt-${index}`
    worktrees.push(makeWorktree({ id: worktreeId, repoId: TEST_REPO.id }))
    const tabs: ReturnType<typeof makeTab>[] = []
    const unified: ReturnType<typeof makeUnifiedTab>[] = []
    for (let tab = 0; tab < (index % 2 === 0 ? 1 : 2); tab += 1) {
      const tabId = `tab-${index}-${tab}`
      tabs.push(makeTab({ id: tabId, worktreeId, title: `Terminal ${index}-${tab}` }))
      unified.push(
        makeUnifiedTab({
          id: tabId,
          worktreeId,
          groupId: `group-${index}`,
          label: `Label ${index}`
        })
      )
      paneKeys.push(makePaneKey(tabId, LEAF_ID))
      owners.push({ tabId, worktreeId })
    }
    tabsByWorktree[worktreeId] = onTabVisit ? CountingTabList.from(tabs) : tabs
    unifiedTabsByWorktree[worktreeId] = unified
  }
  const state = {
    repos: [TEST_REPO],
    worktreesByRepo: { [TEST_REPO.id]: worktrees },
    tabsByWorktree,
    unifiedTabsByWorktree,
    terminalLayoutsByTabId: {},
    settings: { ...settings, tabAutoGenerateTitle: false }
  } satisfies Partial<AppState>
  store.setState(state)
  const agentStatusByPaneKey = Object.fromEntries(
    paneKeys
      .map((paneKey, index): [string, AgentStatusEntry] => [
        paneKey,
        {
          paneKey,
          ...owners[index],
          state: 'working',
          agentType: 'claude',
          prompt: 'initial prompt',
          updatedAt: 2_000_000_000,
          stateStartedAt: 2_000_000_000,
          firstStateStartedAt: 2_000_000_000,
          stateHistory: []
        } satisfies AgentStatusEntry
      ])
      .filter((_, index) => owners[index].tabId.endsWith('-0'))
  )
  return { store, state, paneKeys, owners, agentStatusByPaneKey }
}
