/**
 * GH #10205: a manual sleep keeps the tab's session id as a wake hint, so a later
 * remount of its still-mounted pane reattaches that dead id and the daemon spawns
 * a fresh shell. Production parking timings are deliberate: a shrunk park delay
 * unmounts the slept panes and hides the behavior.
 */
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { getAllWorktreeIds, waitForSessionReady } from './helpers/store'
import {
  activateWorkspaceByClick,
  giveWorkspaceALivePty,
  readConnectDiagnostics,
  readHostLiveTerminalCount,
  readWorkspaceSample,
  sleepWorkspaceViaSidebar
} from './helpers/slept-workspace-probe'

const OBSERVATION_MS = 8_000
const SAMPLE_INTERVAL_MS = 200

async function assertStaysCold(page: Page, worktreeId: string): Promise<void> {
  let peakLivePty = 0
  let peakTabs = 0
  const deadline = Date.now() + OBSERVATION_MS
  while (Date.now() < deadline) {
    const sample = await readWorkspaceSample(page, worktreeId)
    peakLivePty = Math.max(peakLivePty, sample.livePtyCount)
    peakTabs = Math.max(peakTabs, sample.tabCount)
    await page.waitForTimeout(SAMPLE_INTERVAL_MS)
  }
  const hostLive = await readHostLiveTerminalCount(page, worktreeId)
  const diag = await readConnectDiagnostics(page, worktreeId)
  console.error(`[#10205] ${JSON.stringify({ peakLivePty, peakTabs, hostLive, diag })}`)
  expect(peakLivePty, 'slept workspace grew a live PTY').toBe(0)
  expect(peakTabs, 'slept workspace grew a tab').toBe(1)
  expect(hostLive, 'host created a session for the slept workspace').toBe(0)
}

test('remounting a slept hidden pane does not respawn its PTY', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  const [slept, other] = await getAllWorktreeIds(orcaPage)
  expect(other, 'seeded repo must expose two worktrees').toBeTruthy()
  await giveWorkspaceALivePty(orcaPage, slept)
  await giveWorkspaceALivePty(orcaPage, other)
  await activateWorkspaceByClick(orcaPage, slept)
  expect((await readWorkspaceSample(orcaPage, slept)).livePtyCount).toBeGreaterThan(0)

  await sleepWorkspaceViaSidebar(orcaPage, slept)
  await expect
    .poll(async () => (await readWorkspaceSample(orcaPage, slept)).livePtyCount, {
      timeout: 20_000,
      message: 'sleep did not release the workspace PTYs'
    })
    .toBe(0)
  await activateWorkspaceByClick(orcaPage, other)

  const sample = await readWorkspaceSample(orcaPage, slept)
  const sleptTabId = sample.tabIds[0]
  expect(sleptTabId, 'slept workspace must retain a tab').toBeTruthy()
  // Presence preconditions: the pane is still mounted and still carries its wake hint,
  // otherwise a remount has nothing to reattach and the oracle passes vacuously.
  expect(sample.mountedTabIds, 'slept pane was parked before the remount').toContain(sleptTabId)
  expect(sample.tabPtyHints[0], 'sleep must keep the session id as a wake hint').toBeTruthy()

  const remounted = await orcaPage.evaluate(
    (tabId) => window.__store?.getState().remountTerminalTabForRecovery(tabId) ?? false,
    sleptTabId
  )
  expect(remounted, 'remountTerminalTabForRecovery did not find the slept tab').toBe(true)
  await assertStaysCold(orcaPage, slept)

  // Non-vacuity: a deliberate click must still wake it.
  await activateWorkspaceByClick(orcaPage, slept)
  await expect
    .poll(async () => (await readWorkspaceSample(orcaPage, slept)).livePtyCount, {
      timeout: 40_000,
      message: 'the slept workspace never wakes even on deliberate activation'
    })
    .toBeGreaterThan(0)
})
