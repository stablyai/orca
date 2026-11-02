import type { Page } from '@stablyai/playwright-test'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { launchPairedWebClient, type PairedWebClient } from './helpers/paired-electron-client'
import { callColdActivationRuntime } from './helpers/paired-terminal-cold-activation-observation'
import { createPairedTerminalParkingFixture } from './helpers/paired-terminal-parking-fixture'
import { getTerminalContent, waitForActivePanePtyId } from './helpers/terminal'

// The most recent TERMINAL_WORKTREE_HOT_RETAIN_LIMIT worktrees stay warm, so park needs more.
const WARM_WORKTREE_COUNT = 4

let probeCount = 0

/** Asks the PTY's own process for its grid; the token ties the reply to this request. */
async function readHostPtySize(
  page: Page,
  terminal: string,
  readReportedSize: (token: string) => string | null
): Promise<string | null> {
  const token = `probe${++probeCount}`
  await callColdActivationRuntime(page, 'terminal.send', {
    terminal,
    text: `SIZE:${token}`,
    enter: true,
    client: { id: 'viewer-size-e2e', type: 'desktop' }
  })
  let size: string | null = null
  await expect.poll(() => (size = readReportedSize(token)), { timeout: 10_000 }).not.toBeNull()
  return size
}

// Parking closes the client's stream, the last viewer of the PTY. A windowless host has no pane
// to hand the size back to, so the PTY must keep the viewer's grid instead of its spawn grid,
// or every reveal replays a snapshot at a foreign grid (#15997).
test('a headless host keeps a parked terminal at its last viewer grid', async ({
  testRepoPath
}) => {
  test.setTimeout(240_000)
  const host = await launchHeadlessPairedRuntimeHost()
  const fixture = createPairedTerminalParkingFixture()
  let client: PairedWebClient | null = null
  try {
    const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
      path: testRepoPath,
      kind: 'git'
    })
    client = await launchPairedWebClient(host.app, host.offer, { terminalParkingDelayMs: 100 })
    const page = client.page
    await expect
      .poll(() => page.evaluate(() => window.__store?.getState().allWorktrees()[0]?.id ?? null), {
        timeout: 30_000
      })
      .not.toBeNull()
    const fallbackWorktreeId = await page.evaluate(
      () => window.__store?.getState().allWorktrees()[0]?.id ?? ''
    )
    await page.evaluate(async () => {
      await window.__store?.getState().updateSettings({
        terminalHiddenViewParking: true,
        terminalHiddenWorktreeRetentionBudget: false
      })
    })
    const marker = `VIEWER_SIZE_${Date.now()}`
    const worktrees: { worktreeId: string; terminal: string; tabId: string }[] = []
    for (let index = 0; index <= WARM_WORKTREE_COUNT; index += 1) {
      const created = await callColdActivationRuntime<{
        startupTerminal?: { handle?: string; tabId?: string }
        worktree: { id: string }
      }>(page, 'worktree.create', {
        repo: added.result.repo.id,
        name: `viewer-size-${Date.now()}-${index}`,
        setupDecision: 'skip',
        activate: false,
        noParent: true,
        startupCommand: fixture.command(`${marker}_${index}`)
      })
      const handle = created.startupTerminal?.handle
      const hostTabId = created.startupTerminal?.tabId
      if (!handle || !hostTabId) {
        throw new Error(`Viewer-size startup terminal ${index} was not created`)
      }
      worktrees.push({
        worktreeId: created.worktree.id,
        terminal: handle,
        tabId: toWebTerminalSurfaceTabId(hostTabId)
      })
    }
    const openTab = async (entry: { worktreeId: string; tabId: string }): Promise<void> => {
      await page.evaluate((id) => {
        const state = window.__store?.getState()
        state?.setActiveView('terminal')
        state?.setActiveWorktree(id)
      }, entry.worktreeId)
      const tab = page.locator(`[data-testid="sortable-tab"][data-tab-id="${entry.tabId}"]`)
      await expect(tab).toBeVisible({ timeout: 30_000 })
      await tab.click()
      await waitForActivePanePtyId(page, 30_000)
    }
    const target = worktrees[0]
    await openTab(target)
    await expect
      .poll(() => getTerminalContent(page), { timeout: 30_000 })
      .toContain(`READY:${marker}_0`)
    const paneGrid = await page.evaluate((id) => {
      const terminal = window.__paneManagers?.get(id)?.getActivePane()?.terminal
      return terminal ? `${terminal.cols}x${terminal.rows}` : null
    }, target.tabId)
    const readTargetSize = (): Promise<string | null> =>
      readHostPtySize(page, target.terminal, (token) =>
        fixture.readReportedSize(`${marker}_0`, token)
      )
    await expect
      .poll(readTargetSize, { timeout: 30_000, intervals: [500, 1_000, 2_000] })
      .toBe(paneGrid)

    for (const warm of worktrees.slice(1)) {
      await openTab(warm)
    }
    await page.evaluate(
      (id) => window.__store?.getState().setActiveWorktree(id),
      fallbackWorktreeId
    )
    await expect
      .poll(
        () =>
          page.evaluate(
            (id) =>
              !window.__paneManagers?.has(id) &&
              (window.__terminalParkingDebug?.parkedTabIds() ?? []).includes(id),
            target.tabId
          ),
        { timeout: 30_000 }
      )
      .toBe(true)
    // Give a reclaim, if any, time to land before sampling the parked PTY.
    await page.waitForTimeout(1_000)
    expect(await readTargetSize()).toBe(paneGrid)
  } finally {
    await client?.dispose()
    await host.dispose()
    fixture.dispose()
  }
})
