/**
 * A tab area showing one pane opens the next pane beside it; with two, the next tab opens opposite.
 * Runs hidden: the orca-app fixture sets ORCA_BACKGROUND_LAUNCH; never reveal the window.
 */
import { existsSync, readFileSync } from 'node:fs'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { TEST_REPO_PATH_FILE } from './global-setup'

type TabAreaPaneCounts = {
  leaves: number
  unsplitHosts: number
  emptyGroups: number
  groupBodies: number
}

async function readPanes(page: Page, worktreeId: string): Promise<TabAreaPaneCounts> {
  return page.evaluate((wt): TabAreaPaneCounts => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    type LayoutNode = { type: 'leaf' } | { type: 'split'; first: LayoutNode; second: LayoutNode }
    const countLeaves = (node: LayoutNode | undefined): number =>
      !node ? 0 : node.type === 'leaf' ? 1 : countLeaves(node.first) + countLeaves(node.second)
    const tabs = state.unifiedTabsByWorktree[wt] ?? []
    return {
      leaves: countLeaves(state.layoutByWorktree[wt]),
      unsplitHosts: document.querySelectorAll('[data-tab-area-unsplit]').length,
      emptyGroups: (state.groupsByWorktree[wt] ?? []).filter(
        (group: { id: string }) =>
          !tabs.some((tab: { groupId: string }) => tab.groupId === group.id)
      ).length,
      groupBodies: document.querySelectorAll('[data-tab-group-body-id]').length
    }
  }, worktreeId)
}

test.describe.configure({ mode: 'serial' })

test('the second pane opens beside the first, the third opens opposite as a tab', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)

  // Startup with the default terminal is one pane, not already split.
  await expect
    .poll(() => readPanes(orcaPage, worktreeId))
    .toMatchObject({ leaves: 1, emptyGroups: 0, groupBodies: 1 })
  expect((await readPanes(orcaPage, worktreeId)).unsplitHosts).toBeGreaterThan(0)
  await orcaPage.screenshot({ path: testInfo.outputPath('1-one-pane.png') })

  // A new terminal (the expensive half) opens beside it and focuses.
  await orcaPage.evaluate((wt) => {
    window.__store?.getState().createTab(wt)
  }, worktreeId)
  await expect
    .poll(() => readPanes(orcaPage, worktreeId))
    .toMatchObject({
      leaves: 2,
      unsplitHosts: 0,
      emptyGroups: 0,
      groupBodies: 2
    })
  await orcaPage.screenshot({ path: testInfo.outputPath('2-two-terminals.png') })
  const rightGroupId = await orcaPage.evaluate(
    (wt) => window.__store?.getState().activeGroupIdByWorktree[wt],
    worktreeId
  )

  // A browser tab is the third pane candidate: a tab in the panel opposite the focused one, not a pane.
  await orcaPage.evaluate((wt) => {
    window.__store
      ?.getState()
      .createBrowserTab(wt, 'about:blank', { activate: true, focusAddressBar: false })
  }, worktreeId)
  await expect
    .poll(() => readPanes(orcaPage, worktreeId))
    .toMatchObject({ leaves: 2, emptyGroups: 0, groupBodies: 2 })
  expect(
    await orcaPage.evaluate(
      (wt) =>
        window.__store
          ?.getState()
          .unifiedTabsByWorktree[wt]?.find((tab) => tab.contentType === 'browser')?.groupId,
      worktreeId
    )
  ).not.toBe(rightGroupId)
  await orcaPage.screenshot({ path: testInfo.outputPath('3-third-opens-opposite.png') })

  // Closing the right pane re-arms the rule.
  await orcaPage.evaluate(
    ([wt, groupId]) => {
      const state = window.__store?.getState()
      if (!state) {
        return
      }
      for (const tab of state.unifiedTabsByWorktree[wt] ?? []) {
        if (tab.groupId === groupId) {
          state.closeUnifiedTab(tab.id)
        }
      }
    },
    [worktreeId, rightGroupId] as const
  )
  await expect.poll(() => readPanes(orcaPage, worktreeId)).toMatchObject({ leaves: 1 })

  await orcaPage.evaluate((wt) => {
    window.__store?.getState().createTab(wt, undefined, undefined, { activate: false })
  }, worktreeId)
  // An automatic, unfocused open still splits and still leaves no empty pane.
  await expect
    .poll(() => readPanes(orcaPage, worktreeId))
    .toMatchObject({
      leaves: 2,
      unsplitHosts: 0,
      emptyGroups: 0,
      groupBodies: 2
    })
  await orcaPage.screenshot({ path: testInfo.outputPath('4-background-open-splits.png') })
})

test('reopening a closed tab returns it to its pane instead of splitting', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)

  // Two terminals in ONE group (created with placement fixed), close one, reopen it.
  await orcaPage.evaluate((wt) => {
    const state = window.__store?.getState()
    if (!state) {
      return
    }
    const groupId = state.activeGroupIdByWorktree[wt]
    const second = state.createTab(wt, groupId, undefined, { placementFixed: true })
    state.closeTab(second.id)
    state.reopenClosedTerminalTab(wt)
  }, worktreeId)

  await expect
    .poll(() => readPanes(orcaPage, worktreeId))
    .toMatchObject({ leaves: 1, groupBodies: 1 })
})

test('a saved layout comes back as it was, split or not', async (// oxlint-disable-next-line no-empty-pattern -- this test owns both Electron launches.
{}, testInfo) => {
  test.setTimeout(300_000)
  const repoPath = existsSync(TEST_REPO_PATH_FILE)
    ? readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
    : ''
  if (!repoPath) {
    throw new Error('This spec requires the seeded test repo from global setup')
  }
  const session = createRestartSession(testInfo)
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null

  try {
    const first = await session.launch()
    firstApp = first.app
    await waitForSessionReady(first.page)
    const worktreeId = await attachRepoAndOpenTerminal(first.page, repoPath)
    await ensureTerminalVisible(first.page)

    // A second terminal splits, so the saved layout has two panes.
    await first.page.evaluate((wt) => {
      window.__store?.getState().createTab(wt)
    }, worktreeId)
    await expect.poll(() => readPanes(first.page, worktreeId)).toMatchObject({ leaves: 2 })
    await session.close(firstApp)
    firstApp = null

    const second = await session.launch()
    secondApp = second.app
    await waitForSessionReady(second.page)
    await ensureTerminalVisible(second.page)
    await expect.poll(() => readPanes(second.page, worktreeId)).toMatchObject({ leaves: 2 })

    // Collapse to one pane holding two tabs, quit again: restore must keep ONE leaf.
    await second.page.evaluate((wt) => {
      const state = window.__store?.getState()
      if (!state) {
        return
      }
      const [left, right] = state.groupsByWorktree[wt] ?? []
      for (const tab of state.unifiedTabsByWorktree[wt] ?? []) {
        if (tab.groupId === right?.id) {
          state.moveUnifiedTabToGroup(tab.id, left.id)
        }
      }
    }, worktreeId)
    await expect.poll(() => readPanes(second.page, worktreeId)).toMatchObject({ leaves: 1 })
    await session.close(secondApp)
    secondApp = null

    const third = await session.launch()
    secondApp = third.app
    await waitForSessionReady(third.page)
    await ensureTerminalVisible(third.page)
    await expect.poll(() => readPanes(third.page, worktreeId)).toMatchObject({ leaves: 1 })
    expect(
      await third.page.evaluate(
        (wt) => (window.__store?.getState().unifiedTabsByWorktree[wt] ?? []).length,
        worktreeId
      )
    ).toBe(2)
  } finally {
    if (firstApp) {
      await session.close(firstApp)
    }
    if (secondApp) {
      await session.close(secondApp)
    }
    await session.dispose()
  }
})
