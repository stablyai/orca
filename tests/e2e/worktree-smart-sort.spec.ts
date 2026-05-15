import { test, expect } from './helpers/orca-app'
import type { Page } from '@stablyai/playwright-test'
import type { TerminalPaneLayoutNode } from '../../src/shared/types'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

type SmartSortScenario = {
  blockedId: string
  doneId: string
}

const WORKTREE_OPTION_PREFIX = 'worktree-list-option-'

async function getVisibleWorktreeIdsByTop(page: Page): Promise<string[]> {
  return page.locator(`[role="option"][id^="${WORKTREE_OPTION_PREFIX}"]`).evaluateAll((elements) =>
    elements
      .map((element) => ({
        id: decodeURIComponent(element.id.slice('worktree-list-option-'.length)),
        top: element.getBoundingClientRect().top
      }))
      .sort((a, b) => a.top - b.top)
      .map((row) => row.id)
  )
}

async function seedSmartSortScenario(page: Page): Promise<SmartSortScenario> {
  return page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }

    const state = store.getState()
    state.setActiveView('terminal')
    state.setSidebarOpen(true)
    state.setGroupBy('none')
    state.setSortBy('smart')

    const worktrees = Object.values(state.worktreesByRepo)
      .flat()
      .filter((worktree) => !worktree.isArchived)
    if (worktrees.length < 2) {
      throw new Error('Smart sort E2E needs at least two worktrees')
    }

    const [blocked, done] = worktrees
    const now = Date.now()

    store.setState((current) => ({
      worktreesByRepo: Object.fromEntries(
        Object.entries(current.worktreesByRepo).map(([repoId, repoWorktrees]) => [
          repoId,
          repoWorktrees.map((worktree) => {
            if (worktree.id === blocked.id) {
              return {
                ...worktree,
                displayName: 'Z smart-sort blocked',
                lastActivityAt: now - 5 * 60_000,
                sortOrder: 0
              }
            }
            if (worktree.id === done.id) {
              return {
                ...worktree,
                displayName: 'A smart-sort done',
                lastActivityAt: now,
                sortOrder: 10
              }
            }
            return worktree
          })
        ])
      )
    }))

    for (const worktree of [blocked, done]) {
      const currentState = store.getState()
      if ((currentState.tabsByWorktree[worktree.id] ?? []).length === 0) {
        currentState.createTab(worktree.id)
      }
    }

    const stateWithTabs = store.getState()
    const blockedTab = stateWithTabs.tabsByWorktree[blocked.id]?.[0]
    const doneTab = stateWithTabs.tabsByWorktree[done.id]?.[0]
    if (!blockedTab || !doneTab) {
      throw new Error('Smart sort E2E failed to create terminal tabs')
    }

    const blockedPtyId = stateWithTabs.ptyIdsByTabId[blockedTab.id]?.[0] ?? `e2e-${blockedTab.id}`
    const donePtyId = stateWithTabs.ptyIdsByTabId[doneTab.id]?.[0] ?? `e2e-${doneTab.id}`
    const firstLayoutLeafId = (node: TerminalPaneLayoutNode | null | undefined): string | null => {
      if (!node) {
        return null
      }
      return node.type === 'leaf'
        ? node.leafId
        : (firstLayoutLeafId(node.first) ?? firstLayoutLeafId(node.second))
    }
    let blockedLeafId = ''
    let doneLeafId = ''

    // Why: WorktreeList intentionally holds cold-start ordering until a live
    // PTY exists. E2E hidden windows can create tabs before panes mount, so
    // seed the live-PTY and stable-layout maps explicitly and let agent-status
    // writes drive the same sortEpoch path that hook events use in the app.
    store.setState((current) => {
      const blockedLayout = current.terminalLayoutsByTabId[blockedTab.id]
      const doneLayout = current.terminalLayoutsByTabId[doneTab.id]
      blockedLeafId = firstLayoutLeafId(blockedLayout?.root) ?? crypto.randomUUID()
      doneLeafId = firstLayoutLeafId(doneLayout?.root) ?? crypto.randomUUID()

      return {
        ptyIdsByTabId: {
          ...current.ptyIdsByTabId,
          [blockedTab.id]: current.ptyIdsByTabId[blockedTab.id]?.length
            ? current.ptyIdsByTabId[blockedTab.id]
            : [blockedPtyId],
          [doneTab.id]: current.ptyIdsByTabId[doneTab.id]?.length
            ? current.ptyIdsByTabId[doneTab.id]
            : [donePtyId]
        },
        terminalLayoutsByTabId: {
          ...current.terminalLayoutsByTabId,
          [blockedTab.id]: {
            root: blockedLayout?.root ?? { type: 'leaf', leafId: blockedLeafId },
            activeLeafId: blockedLayout?.activeLeafId ?? blockedLeafId,
            expandedLeafId: blockedLayout?.expandedLeafId ?? null,
            ptyIdsByLeafId: {
              ...blockedLayout?.ptyIdsByLeafId,
              [blockedLeafId]: blockedPtyId
            }
          },
          [doneTab.id]: {
            root: doneLayout?.root ?? { type: 'leaf', leafId: doneLeafId },
            activeLeafId: doneLayout?.activeLeafId ?? doneLeafId,
            expandedLeafId: doneLayout?.expandedLeafId ?? null,
            ptyIdsByLeafId: {
              ...doneLayout?.ptyIdsByLeafId,
              [doneLeafId]: donePtyId
            }
          }
        }
      }
    })

    const actions = store.getState()
    actions.setAgentStatus(
      `${doneTab.id}:${doneLeafId}`,
      { state: 'done', prompt: 'Finished', agentType: 'codex' },
      'codex',
      { updatedAt: now, stateStartedAt: now - 1_000 }
    )
    actions.setAgentStatus(
      `${blockedTab.id}:${blockedLeafId}`,
      { state: 'blocked', prompt: 'Needs approval', agentType: 'codex' },
      'codex',
      { updatedAt: now, stateStartedAt: now - 60_000 }
    )

    return { blockedId: blocked.id, doneId: done.id }
  })
}

test.describe('Worktree Smart Sort', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  test('renders attention-needed worktrees above finished agents in Smart mode', async ({
    orcaPage
  }) => {
    const { blockedId, doneId } = await seedSmartSortScenario(orcaPage)

    await expect
      .poll(async () => (await getVisibleWorktreeIdsByTop(orcaPage)).slice(0, 2), {
        timeout: 8_000,
        message: 'Smart sort did not promote the blocked worktree in the visible sidebar'
      })
      .toEqual([blockedId, doneId])

    await expect(
      orcaPage.locator(`[id="${WORKTREE_OPTION_PREFIX}${encodeURIComponent(blockedId)}"]`)
    ).toBeVisible()
    await expect(
      orcaPage.locator(`[id="${WORKTREE_OPTION_PREFIX}${encodeURIComponent(doneId)}"]`)
    ).toBeVisible()
  })
})
