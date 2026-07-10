import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForPaneIdentitySnapshot,
  type PaneIdentitySnapshot
} from './helpers/terminal'
import { clickFileInExplorer } from './helpers/file-explorer'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

type SeededActivityThread = {
  paneKey: string
  leafId: string
  prompt: string
}

type ActivityPaneVisibility = {
  slotId: string | null
  allLeafIds: string[]
  visibleLeafIds: string[]
}

type ActivePaneSelection = {
  activeWorktreeId: string | null
  activeGroupId: string | null
  activeTabId: string | null
  activeTabType: string | null
  activeLeafId: string | null
  activePaneId: number | null
}

type SplitGroupTerminal = {
  sourceGroupId: string
  groupId: string
  tabId: string
}

function agentsSidebarButton(page: Page) {
  return page.getByRole('button', { name: /^Agents(?:\s+\d+)?$/ }).first()
}

async function seedActivityThread(
  page: Page,
  thread: SeededActivityThread,
  title: string,
  state: 'blocked' | 'done',
  message: string,
  startedAt: number
): Promise<void> {
  await page.evaluate(
    ({ thread, title, state, message, startedAt }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }

      store.getState().setAgentStatus(
        thread.paneKey,
        {
          state,
          prompt: thread.prompt,
          agentType: 'codex',
          lastAssistantMessage: message
        },
        title,
        { updatedAt: startedAt, stateStartedAt: startedAt }
      )
    },
    { thread, title, state, message, startedAt }
  )
}

async function seedActivityThreadsForSplitPanes(
  page: Page,
  snapshot: PaneIdentitySnapshot
): Promise<[SeededActivityThread, SeededActivityThread]> {
  const [firstPane, secondPane] = snapshot.panes
  if (!firstPane || !secondPane) {
    throw new Error('Activity pane isolation test needs two split panes')
  }

  const now = Date.now()
  const first: SeededActivityThread = {
    paneKey: `${snapshot.tabId}:${firstPane.leafId}`,
    leafId: firstPane.leafId,
    prompt: `ACTIVITY_UUID_LEFT_${now}`
  }
  const second: SeededActivityThread = {
    paneKey: `${snapshot.tabId}:${secondPane.leafId}`,
    leafId: secondPane.leafId,
    prompt: `ACTIVITY_UUID_RIGHT_${now}`
  }

  await seedActivityThread(
    page,
    first,
    'Codex left pane',
    'blocked',
    'Left pane is waiting for user input.',
    now - 2_000
  )
  await seedActivityThread(
    page,
    second,
    'Codex right pane',
    'done',
    'Right pane finished its turn.',
    now - 1_000
  )

  return [first, second]
}

async function readActivityPaneVisibility(page: Page): Promise<ActivityPaneVisibility> {
  return page.evaluate(() => {
    const slot = document.querySelector<HTMLElement>(
      '[data-activity-terminal-slot-id]:not([aria-hidden="true"])'
    )
    if (!slot) {
      return { slotId: null, allLeafIds: [], visibleLeafIds: [] }
    }

    const hasInlineDisplayNoneBetween = (element: HTMLElement, root: HTMLElement): boolean => {
      let current: HTMLElement | null = element
      while (current) {
        if (current.style.display === 'none') {
          return true
        }
        if (current === root) {
          return false
        }
        current = current.parentElement
      }
      return false
    }

    const panes = Array.from(slot.querySelectorAll<HTMLElement>('[data-leaf-id]'))
    return {
      slotId: slot.dataset.activityTerminalSlotId ?? null,
      allLeafIds: panes.map((pane) => pane.dataset.leafId ?? ''),
      visibleLeafIds: panes
        .filter((pane) => !hasInlineDisplayNoneBetween(pane, slot))
        .map((pane) => pane.dataset.leafId ?? '')
    }
  })
}

async function enableInlineAgentCards(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }

    const state = store.getState()
    if (!state.worktreeCardProperties.includes('inline-agents')) {
      state.toggleWorktreeCardProperty('inline-agents')
    }
    state.closeActivityPage()
  })
}

async function enableActivityAgentsView(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const settings = await window.api.settings.set({ experimentalActivity: true })
    // Why: these specs exercise the experimental Agents page. E2E profiles use
    // production defaults, where the sidebar entry is hidden unless enabled.
    window.__store?.setState({ settings })
  })
}

async function clickWorkspaceCardAgentRow(page: Page, prompt: string): Promise<void> {
  const agentsGroup = page.getByRole('group', { name: 'Agents' }).first()
  const collapsedSummary = agentsGroup.getByRole('button', { name: /^Expand \d+ agents?:/ })
  if (await collapsedSummary.isVisible()) {
    await collapsedSummary.click()
  }
  const agentRow = agentsGroup.getByRole('treeitem').filter({ hasText: prompt }).first()
  await expect(agentRow).toBeVisible({ timeout: 10_000 })
  await agentRow.click()
}

async function readActivePaneSelection(page: Page): Promise<ActivePaneSelection> {
  return page.evaluate(() => {
    const store = window.__store
    if (!store) {
      return {
        activeWorktreeId: null,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        activeLeafId: null,
        activePaneId: null
      }
    }

    const state = store.getState()
    const activeWorktreeId = state.activeWorktreeId ?? null
    const activeGroupId = activeWorktreeId
      ? (state.activeGroupIdByWorktree[activeWorktreeId] ?? null)
      : null
    const activeTabId = state.activeTabId ?? null
    const activePane = activeTabId
      ? (window.__paneManagers?.get(activeTabId)?.getActivePane?.() ?? null)
      : null

    return {
      activeWorktreeId,
      activeGroupId,
      activeTabId,
      activeTabType: state.activeTabType ?? null,
      activeLeafId: activePane?.leafId ?? null,
      activePaneId: activePane?.id ?? null
    }
  })
}

function terminalPaneForLeaf(page: Page, leafId: string) {
  return page.locator(`.pane[data-leaf-id="${leafId}"]`).first()
}

async function createTerminalInNewSplitGroup(page: Page): Promise<SplitGroupTerminal> {
  return page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const state = store.getState()
    const worktreeId = state.activeWorktreeId
    if (!worktreeId) {
      throw new Error('No active worktree for split-group terminal setup')
    }
    const sourceGroupId =
      state.activeGroupIdByWorktree[worktreeId] ?? state.groupsByWorktree[worktreeId]?.[0]?.id
    if (!sourceGroupId) {
      throw new Error('No source group for split-group terminal setup')
    }

    const groupId = state.createEmptySplitGroup(worktreeId, sourceGroupId, 'right')
    if (!groupId) {
      throw new Error('Failed to create split group')
    }

    const tab = state.createTab(worktreeId, groupId, undefined, { activate: true })
    state.focusGroup(worktreeId, groupId)
    state.setActiveTab(tab.id)
    state.setActiveTabType('terminal')
    return { sourceGroupId, groupId, tabId: tab.id }
  })
}

test.describe('Activity Agent Pane Isolation', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await enableActivityAgentsView(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const hasPaneManager = await waitForActiveTerminalManager(orcaPage, 30_000)
      .then(() => true)
      .catch(() => false)
    test.skip(
      !hasPaneManager,
      'Electron automation in this environment never mounts the live TerminalPane manager, so Activity pane isolation would only fail on harness setup.'
    )
    await waitForPaneCount(orcaPage, 1, 30_000)
  })

  test('selecting agent rows isolates the matching split pane by stable leaf id', async ({
    orcaPage
  }) => {
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)
    const snapshot = await waitForPaneIdentitySnapshot(orcaPage, 2)
    const [first, second] = await seedActivityThreadsForSplitPanes(orcaPage, snapshot)

    await agentsSidebarButton(orcaPage).click()
    await expect(orcaPage.getByText(first.prompt)).toBeVisible()
    await expect(orcaPage.getByText(second.prompt)).toBeVisible()

    await orcaPage.getByRole('button').filter({ hasText: first.prompt }).first().click()
    await expect
      .poll(async () => readActivityPaneVisibility(orcaPage), {
        timeout: 10_000,
        message: 'Activity did not isolate the first selected split pane'
      })
      .toMatchObject({
        allLeafIds: expect.arrayContaining([first.leafId, second.leafId]),
        visibleLeafIds: [first.leafId]
      })

    await orcaPage.getByRole('button').filter({ hasText: second.prompt }).first().click()
    await expect
      .poll(async () => readActivityPaneVisibility(orcaPage), {
        timeout: 10_000,
        message: 'Activity did not switch isolation to the second selected split pane'
      })
      .toMatchObject({
        allLeafIds: expect.arrayContaining([first.leafId, second.leafId]),
        visibleLeafIds: [second.leafId]
      })
  })

  test('acknowledged stable pane keys clear the Agents unread badge', async ({ orcaPage }) => {
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)
    const snapshot = await waitForPaneIdentitySnapshot(orcaPage, 2)
    // Why: useAutoAckViewedAgent (App.tsx) auto-acknowledges the agent on the
    // store's *active* visible terminal leaf the instant its status lands, which
    // clears the unread badge before we can assert it (flaky on focused xvfb CI
    // windows). Seed on the non-active split pane — auto-ack only ever targets the
    // active leaf — so the badge stays unread until the explicit acknowledgeAgents()
    // call under test.
    const activeLeafId = await orcaPage.evaluate(
      (tabId) => window.__store?.getState().terminalLayoutsByTabId[tabId]?.activeLeafId ?? null,
      snapshot.tabId
    )
    const targetPane =
      snapshot.panes.find((pane) => pane.leafId !== activeLeafId) ?? snapshot.panes[0]
    if (!targetPane) {
      throw new Error('Activity acknowledgement test needs a split pane')
    }
    const now = Date.now()
    const thread: SeededActivityThread = {
      paneKey: `${snapshot.tabId}:${targetPane.leafId}`,
      leafId: targetPane.leafId,
      prompt: `ACTIVITY_ACK_STABLE_PANE_${now}`
    }

    await orcaPage.evaluate(() => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      const state = store.getState()
      for (const worktree of Object.values(state.worktreesByRepo).flat()) {
        state.markWorktreeVisited(worktree.id)
      }
    })

    await seedActivityThread(
      orcaPage,
      thread,
      'Codex acknowledged pane',
      'blocked',
      'Waiting for acknowledgement migration coverage.',
      now - 5_000
    )

    await expect(agentsSidebarButton(orcaPage)).toHaveAccessibleName(/^Agents\s+1$/)

    await orcaPage.evaluate((paneKey) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      store.getState().acknowledgeAgents([paneKey])
    }, thread.paneKey)

    await expect(agentsSidebarButton(orcaPage)).toHaveAccessibleName(/^Agents$/)
    await expect(orcaPage.getByRole('button', { name: /^Agents\s+1$/ })).toHaveCount(0)
  })

  test('workspace card agent rows focus the matching terminal split pane', async ({ orcaPage }) => {
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)
    const snapshot = await waitForPaneIdentitySnapshot(orcaPage, 2)
    const [first, second] = await seedActivityThreadsForSplitPanes(orcaPage, snapshot)

    await enableInlineAgentCards(orcaPage)

    await clickWorkspaceCardAgentRow(orcaPage, first.prompt)
    await expect
      .poll(async () => readActivePaneSelection(orcaPage), {
        timeout: 10_000,
        message: 'Workspace-card row did not focus the first split pane'
      })
      .toMatchObject({
        activeTabId: snapshot.tabId,
        activeLeafId: first.leafId
      })

    await clickWorkspaceCardAgentRow(orcaPage, second.prompt)
    await expect
      .poll(async () => readActivePaneSelection(orcaPage), {
        timeout: 10_000,
        message: 'Workspace-card row did not focus the second split pane'
      })
      .toMatchObject({
        activeTabId: snapshot.tabId,
        activeLeafId: second.leafId
      })
  })

  test('workspace card agent rows reveal terminal logs from a non-terminal surface', async ({
    orcaPage
  }) => {
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)
    const snapshot = await waitForPaneIdentitySnapshot(orcaPage, 2)
    const [first] = await seedActivityThreadsForSplitPanes(orcaPage, snapshot)

    await enableInlineAgentCards(orcaPage)
    await expect(terminalPaneForLeaf(orcaPage, first.leafId)).toBeVisible()
    // Why: this reproduces the user-visible failure mode: the agent row is
    // visible in the sidebar while the main workspace surface is not Terminal.
    await expect(await clickFileInExplorer(orcaPage, ['README.md'])).toBe('README.md')
    await expect
      .poll(() => readActivePaneSelection(orcaPage))
      .toMatchObject({
        activeTabType: 'editor',
        activeTabId: snapshot.tabId
      })
    await expect(terminalPaneForLeaf(orcaPage, first.leafId)).toBeHidden()

    await clickWorkspaceCardAgentRow(orcaPage, first.prompt)

    await expect
      .poll(async () => readActivePaneSelection(orcaPage), {
        timeout: 10_000,
        message: 'Workspace-card row did not reveal the terminal log surface'
      })
      .toMatchObject({
        activeTabType: 'terminal',
        activeTabId: snapshot.tabId,
        activeLeafId: first.leafId
      })
    await expect(terminalPaneForLeaf(orcaPage, first.leafId)).toBeVisible()
  })

  test('workspace card agent rows focus the matching split-group terminal pane', async ({
    orcaPage
  }) => {
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)
    const firstGroupSnapshot = await waitForPaneIdentitySnapshot(orcaPage, 2)
    const [first, second] = await seedActivityThreadsForSplitPanes(orcaPage, firstGroupSnapshot)

    const splitGroup = await createTerminalInNewSplitGroup(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await waitForPaneCount(orcaPage, 1, 30_000)
    const secondGroupSnapshot = await waitForPaneIdentitySnapshot(orcaPage, 1)
    const secondGroupPane = secondGroupSnapshot.panes[0]
    if (!secondGroupPane) {
      throw new Error('Split-group terminal did not mount a pane')
    }
    const now = Date.now()
    const splitGroupThread: SeededActivityThread = {
      paneKey: `${secondGroupSnapshot.tabId}:${secondGroupPane.leafId}`,
      leafId: secondGroupPane.leafId,
      prompt: `ACTIVITY_UUID_SPLIT_GROUP_${now}`
    }
    await seedActivityThread(
      orcaPage,
      splitGroupThread,
      'Codex split group pane',
      'blocked',
      'Split group pane is waiting for user input.',
      now
    )

    await enableInlineAgentCards(orcaPage)

    await clickWorkspaceCardAgentRow(orcaPage, splitGroupThread.prompt)
    await expect
      .poll(async () => readActivePaneSelection(orcaPage), {
        timeout: 10_000,
        message: 'Workspace-card row did not focus the split-group terminal pane'
      })
      .toMatchObject({
        activeGroupId: splitGroup.groupId,
        activeTabId: secondGroupSnapshot.tabId,
        activeLeafId: splitGroupThread.leafId
      })

    await clickWorkspaceCardAgentRow(orcaPage, first.prompt)
    await expect
      .poll(async () => readActivePaneSelection(orcaPage), {
        timeout: 10_000,
        message: 'Workspace-card row did not return to the first split group'
      })
      .toMatchObject({
        activeGroupId: splitGroup.sourceGroupId,
        activeTabId: firstGroupSnapshot.tabId,
        activeLeafId: first.leafId
      })

    await clickWorkspaceCardAgentRow(orcaPage, second.prompt)
    await expect
      .poll(async () => readActivePaneSelection(orcaPage), {
        timeout: 10_000,
        message: 'Workspace-card row did not focus the sibling pane after group switch'
      })
      .toMatchObject({
        activeGroupId: splitGroup.sourceGroupId,
        activeTabId: firstGroupSnapshot.tabId,
        activeLeafId: second.leafId
      })
  })
})
