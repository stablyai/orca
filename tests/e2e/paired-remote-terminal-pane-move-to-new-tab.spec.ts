import type {
  RuntimeMobileSessionTabsResult,
  RuntimeTerminalListResult
} from '../../src/shared/runtime-types'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import {
  callPairedRuntime,
  waitForPairedClientWorktree
} from './helpers/paired-client-host-session'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import { dragPaneOutToTabStrip, waitForBoundPanes } from './helpers/terminal-layout-journeys'
import { splitActiveTerminalPane } from './helpers/terminal'

const PANE = '.pane[data-leaf-id]:visible'
const TAB = '[data-testid="sortable-tab"]'

type HostLeaves = Record<string, string[]>

/** The server's tabs, each with the leaves it holds. */
function hostLeavesByTab(result: RuntimeMobileSessionTabsResult): HostLeaves {
  const byTab: HostLeaves = {}
  for (const surface of result.tabs) {
    if (surface.type === 'terminal' && surface.leafId) {
      ;(byTab[surface.parentTabId] ??= []).push(surface.leafId)
    }
  }
  return byTab
}

// #32939: a pane dragged out of a split into a new tab on a server workspace must move on the
// server too, or the server's next snapshot puts it back into the split.
test('a pane moved to a new tab on a paired server workspace stays in its new tab', async ({
  testRepoPath
}, testInfo) => {
  // Why: launches a headless server and a paired Electron client, then waits on both.
  test.setTimeout(240_000)
  const host = await launchHeadlessPairedRuntimeHost()
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    const desktop = await launchPairedElectronClient(host.offer, testInfo, 'pane move')
    try {
      const page = desktop.page
      let worktreeId = ''
      await expect
        .poll(
          async () =>
            (worktreeId = await page.evaluate(
              (repo) =>
                window.__store
                  ?.getState()
                  .allWorktrees()
                  .find((worktree) => worktree.path === repo)?.id ?? '',
              testRepoPath
            )),
          { timeout: 60_000 }
        )
        .not.toBe('')
      const worktree = `id:${worktreeId}`
      const listHost = async (): Promise<RuntimeMobileSessionTabsResult> =>
        (
          await host.client.call<RuntimeMobileSessionTabsResult>('session.tabs.list', {
            worktree
          })
        ).result
      const readHost = async (): Promise<HostLeaves> => hostLeavesByTab(await listHost())
      /** The server's tab order, then the tab it has selected, both as tab ids. */
      const readHostPlacement = async (): Promise<[string[], string | null]> => {
        const listed = await listHost()
        const parentOf = (id: string | null): string | null =>
          listed.tabs
            .flatMap((tab) => (tab.type === 'terminal' ? [tab] : []))
            .find((tab) => tab.id === id || tab.parentTabId === id)?.parentTabId ?? null
        return [
          (listed.tabGroups?.[0]?.tabOrder ?? []).map((id) => parentOf(id) ?? id),
          parentOf(listed.activeTabId)
        ]
      }
      const readClientTabOrder = (): Promise<string[]> =>
        page
          .locator(TAB)
          .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute('data-tab-id') ?? ''))

      // The server makes the source tab, as for a long-running agent; a tab the desktop seeds into an
      // empty workspace is still settling its first spawn when the split lands.
      const created = await host.client.call<{ tab: { parentTabId: string } }>(
        'session.tabs.createTerminal',
        { worktree, activate: false, select: false, navigation: 'caller' }
      )
      const sourceTabId = toWebTerminalSurfaceTabId(created.result.tab.parentTabId)
      await expect
        .poll(
          () =>
            page.evaluate(
              ({ id, tabId }) =>
                (window.__store?.getState().tabsByWorktree[id] ?? []).some(
                  (tab) => tab.id === tabId
                ),
              { id: worktreeId, tabId: sourceTabId }
            ),
          { timeout: 30_000 }
        )
        .toBe(true)
      await page.evaluate((id) => window.__store?.getState().setActiveWorktree(id), worktreeId)
      const sourceTab = page.locator(`${TAB}[data-tab-id="${sourceTabId}"]`)
      await expect(sourceTab).toBeVisible({ timeout: 30_000 })
      await sourceTab.click()
      await waitForBoundPanes(page, 1)
      const firstLeafId = await page.locator(PANE).first().getAttribute('data-leaf-id')
      const hostTerminal = async (leafId: string | null) =>
        (
          await host.client.call<RuntimeTerminalListResult>('terminal.list', { worktree })
        ).result.terminals.find((terminal) => terminal.leafId === leafId)
      // Split once the first shell is up, as a user does.
      await expect
        .poll(async () => (await hostTerminal(firstLeafId))?.preview ?? '', { timeout: 30_000 })
        .not.toBe('')
      const tabCount = await page.locator(TAB).count()
      await splitActiveTerminalPane(page, 'vertical')
      await waitForBoundPanes(page, 2)
      const leafIds = await page
        .locator(PANE)
        .evaluateAll((panes) => panes.map((pane) => pane.getAttribute('data-leaf-id') ?? ''))
      const movedLeafId = leafIds.find((id) => id !== firstLeafId)!
      await expect
        .poll(async () => (await readHost())[created.result.tab.parentTabId]?.length, {
          timeout: 30_000
        })
        .toBe(2)

      // Dropped before the first tab, so the new tab's place differs from the server's append.
      await dragPaneOutToTabStrip(page, worktreeId, movedLeafId, 'start')
      await expect(page.locator(TAB)).toHaveCount(tabCount + 1, { timeout: 15_000 })
      const [movedTabId] = await readClientTabOrder()
      expect(movedTabId).not.toBe(sourceTabId)

      // The server holds the moved leaf alone in another tab.
      await expect
        .poll(
          async () =>
            Object.values(await readHost())
              .filter((leaves) => leaves.includes(movedLeafId))
              .map((leaves) => leaves.join(',')),
          { timeout: 15_000, message: 'the server never moved the pane' }
        )
        .toEqual([movedLeafId])
      const hostTabOfMovedLeaf = Object.entries(await readHost()).find(([, leaves]) =>
        leaves.includes(movedLeafId)
      )?.[0]
      const { terminals } = (
        await host.client.call<RuntimeTerminalListResult>('terminal.list', { worktree })
      ).result
      expect(terminals.find((terminal) => terminal.leafId === movedLeafId)?.tabId).toBe(
        hostTabOfMovedLeaf
      )
      // The server keeps the tab where it was dropped, selected as the window shows it.
      await expect
        .poll(
          async () => {
            const [order, active] = await readHostPlacement()
            return [order[0], active]
          },
          { timeout: 15_000, message: 'the server misplaced the tab' }
        )
        .toEqual([hostTabOfMovedLeaf, hostTabOfMovedLeaf])

      // Switching back to the source tab must not pull the pane back into its split.
      // Then the moved pane writes output, the server's next publish follows, and the pane stays out.
      await sourceTab.click()
      const marker = `MOVED_PANE_OUTPUT_${Date.now()}`
      const moved = await hostTerminal(movedLeafId)
      await host.client.call('terminal.send', {
        terminal: moved!.handle,
        text: `echo ${marker}`,
        enter: true
      })
      await expect
        .poll(async () => (await hostTerminal(movedLeafId))?.preview ?? '', { timeout: 15_000 })
        .toContain(marker)
      const readClient = async () => ({
        tabs: await page.locator(TAB).count(),
        sourcePanes: await page.locator(PANE).count(),
        movedInSource: await page.locator(`${PANE}[data-leaf-id="${movedLeafId}"]`).count(),
        movedFirst: (await readClientTabOrder())[0] === movedTabId
      })
      // A rename published after all of that fences the check: once this window draws it, it has
      // applied every server snapshot since the move, any of which would have pulled the pane back.
      const fence = `moved-${Date.now()}`
      await host.client.call('session.tabs.setTabProps', {
        worktree,
        tabId: hostTabOfMovedLeaf,
        customTitle: fence
      })
      await expect(page.locator(`${TAB}[data-tab-id="${movedTabId}"]`)).toContainText(fence, {
        timeout: 15_000
      })
      expect(await readClient()).toEqual({
        tabs: tabCount + 1,
        sourcePanes: 1,
        movedInSource: 0,
        movedFirst: true
      })
    } finally {
      await desktop.dispose()
    }
  } finally {
    await host.dispose()
  }
})

// A server with a desktop window keeps its layout in that window and refuses the move; this
// desktop must put the pane back at once, terminal intact, not keep a tab the server never had.
test('a pane move the server refuses goes back into its split, terminal intact', async ({
  orcaPage
}, testInfo) => {
  // Why: launches a second, paired Electron client next to the server's own window.
  test.setTimeout(200_000)
  const worktreeId = await orcaPage.evaluate(() => window.__store?.getState().activeWorktreeId)
  if (!worktreeId) {
    throw new Error('Window host has no active seeded workspace')
  }
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const desktop = await launchPairedElectronClient(offer, testInfo, 'refused pane move')
  const page = desktop.page
  try {
    await waitForPairedClientWorktree(page, worktreeId)
    const created = await callPairedRuntime<{ tab: { parentTabId: string } }>(
      page,
      desktop.environmentId,
      'session.tabs.createTerminal',
      { worktree: `id:${worktreeId}`, activate: false, select: false, navigation: 'caller' }
    )
    const sourceTabId = toWebTerminalSurfaceTabId(created.tab.parentTabId)
    await page.evaluate((id) => window.__store?.getState().setActiveWorktree(id), worktreeId)
    const sourceTab = page.locator(`${TAB}[data-tab-id="${sourceTabId}"]`)
    await expect(sourceTab).toBeVisible({ timeout: 30_000 })
    await sourceTab.click()
    await waitForBoundPanes(page, 1)
    const firstLeafId = await page.locator(PANE).first().getAttribute('data-leaf-id')
    const hostTerminalOf = async (leafId: string | null): Promise<string | null> => {
      const { terminals } = await callPairedRuntime<RuntimeTerminalListResult>(
        page,
        desktop.environmentId,
        'terminal.list',
        { worktree: `id:${worktreeId}` }
      )
      return terminals.find((terminal) => terminal.leafId === leafId)?.tabId ?? null
    }
    // Split once the server lists the first terminal, as a user splits a pane that is up.
    await expect.poll(() => hostTerminalOf(firstLeafId), { timeout: 30_000 }).not.toBeNull()
    await splitActiveTerminalPane(page, 'vertical')
    await waitForBoundPanes(page, 2)
    const leafIds = await page
      .locator(PANE)
      .evaluateAll((panes) => panes.map((pane) => pane.getAttribute('data-leaf-id') ?? ''))
    const movedLeafId = leafIds.find((id) => id !== firstLeafId)!
    const tabCount = await page.locator(TAB).count()
    await expect.poll(() => hostTerminalOf(movedLeafId)).toBe(created.tab.parentTabId)

    // The move is asynchronous, so only a tab that appeared and went proves the window moved it and
    // then put it back.
    await page.evaluate((id) => {
      const count = (): number => (window.__store?.getState().tabsByWorktree[id] ?? []).length
      const before = count()
      let added = 0
      window.__store?.subscribe(() => {
        added = Math.max(added, count() - before)
        // Tabs added at most, then now, relative to the drop.
        document.body.dataset.paneMoveTabCounts = `${added}/${count() - before}`
      })
    }, worktreeId)
    await dragPaneOutToTabStrip(page, worktreeId, movedLeafId)
    await expect
      .poll(() => page.evaluate(() => document.body.dataset.paneMoveTabCounts ?? null), {
        timeout: 15_000,
        message: 'the refused move was never drawn and put back'
      })
      .toBe('1/0')
    await expect(page.locator(TAB)).toHaveCount(tabCount)
    await expect(page.locator(`${PANE}[data-leaf-id="${movedLeafId}"]`)).toHaveCount(1, {
      timeout: 15_000
    })
    await expect(page.locator(PANE)).toHaveCount(2)
    expect(await hostTerminalOf(movedLeafId)).toBe(created.tab.parentTabId)
  } finally {
    await desktop.dispose()
  }
})
