// #10205: a slept pane’s dead wake-hint id must not reattach/spawn on incidental remount.
// Keep production park timing because shortened delays unmount the target and hide the regression.
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
  // Why: proves the gate held rather than the pane having quietly unmounted.
  expect(diag.at(-1), 'remounted pane did not wait for the wake').toContain('WAIT FOR WAKE')
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
  // Require mounted pane and wake hint or remount has nothing to reattach.
  expect(sample.mountedTabIds, 'slept pane was parked before the remount').toContain(sleptTabId)
  expect(sample.tabPtyHints[0], 'sleep must keep the session id as a wake hint').toBeTruthy()

  const remounted = await orcaPage.evaluate(
    (tabId) => window.__store?.getState().remountTerminalTabForRecovery(tabId).remounted ?? false,
    sleptTabId
  )
  expect(remounted, 'remountTerminalTabForRecovery did not find the slept tab').toBe(true)
  await assertStaysCold(orcaPage, slept)

  // Positive control: explicit selection must wake exactly once across the remount.
  await activateWorkspaceByClick(orcaPage, slept)
  await expect
    .poll(async () => (await readWorkspaceSample(orcaPage, slept)).livePtyCount, {
      timeout: 40_000,
      message: 'the slept workspace never wakes even on deliberate activation'
    })
    .toBeGreaterThan(0)
  await orcaPage.waitForTimeout(3_000)
  expect((await readWorkspaceSample(orcaPage, slept)).livePtyCount).toBe(1)
  expect(await readHostLiveTerminalCount(orcaPage, slept)).toBe(1)
})
