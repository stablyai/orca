// Require managed SSH pane content/input across reconnect, relaunch/reload, dropped links and host freeze.
// Keep full-screen output live, restore tabs once, and honor closes made while disconnected.
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { reconnect } from './helpers/orcad-convert-flow'
import { readPairedPaneContent } from './helpers/paired-host-terminal'
import { waitForSessionReady } from './helpers/store'
import {
  activateManagedWorkspace,
  echoMarker,
  expectPaneText,
  expectTerminalAnswers,
  launchManagedWorkspace,
  openTerminalTab,
  relaunchManagedApp,
  selectTerminalTab,
  skipUnlessManagedDockerHost,
  terminalTabIds,
  typeInTerminal,
  waitForPane,
  withManagedHost
} from './helpers/orcad-managed-workspace'

skipUnlessManagedDockerHost()
test.skip(process.platform === 'win32', 'The Docker SSH host uses POSIX tooling')

function sshStatus(page: Page, targetId: string): Promise<string | null> {
  return page.evaluate(
    (id) => window.__store?.getState().sshConnectionStates.get(id)?.status ?? null,
    targetId
  )
}

/** A live full-screen app redraws; a frozen or replayed frame does not. */
async function expectTopRedrawing(page: Page, tabId: string): Promise<void> {
  await expectPaneText(page, tabId, 'load average')
  const frame = await readPairedPaneContent(page, tabId)
  await expect.poll(() => readPairedPaneContent(page, tabId), { timeout: 30_000 }).not.toBe(frame)
  expect(await readPairedPaneContent(page, tabId)).toContain('PID')
}

test('a managed pane keeps its scrollback and a running TUI across reconnects', async (// oxlint-disable-next-line no-empty-pattern -- Owns its app launch through a restart session.
{}, testInfo) => {
  test.setTimeout(12 * 60_000)
  await withManagedHost(testInfo, async (fixture) => {
    // The fixture shell emits no OSC title; a real user's shell does, and the new-tab check reads it.
    fixture.host.exec!(`printf '%s\\n' 'PS1="\\[\\e]0;\\u@\\h: \\w\\a\\]$PS1"' >> /root/.bashrc`)
    const { page, seeded } = await launchManagedWorkspace(fixture)
    const first = await openTerminalTab(page, seeded.worktreeId)
    const marker = await echoMarker(page, first, 'RECONNECT_MARKER')

    await reconnect(page, seeded.targetId)
    await selectTerminalTab(page, first)
    await waitForPane(page, first)
    await expectPaneText(page, first, marker)

    await typeInTerminal(page, first, 'top')
    await expectTopRedrawing(page, first)
    for (let round = 0; round < 2; round += 1) {
      await reconnect(page, seeded.targetId)
      await selectTerminalTab(page, first)
      await waitForPane(page, first)
      await expectTopRedrawing(page, first)
    }

    // A tab opened after a reconnect gets its own shell, and survives the next reconnect.
    const fresh = await openTerminalTab(page, seeded.worktreeId)
    expect(fresh).not.toBe(first)
    await expectTerminalAnswers(page, fresh)
    expect(await readPairedPaneContent(page, fresh)).not.toContain(marker)
    await expect
      .poll(
        () =>
          page.evaluate(
            ({ worktreeId, tabId }) =>
              window.__store?.getState().tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)
                ?.title ?? null,
            { worktreeId: seeded.worktreeId, tabId: fresh }
          ),
        { timeout: 60_000, message: 'the new tab kept its placeholder title' }
      )
      .not.toMatch(/^Terminal \d+$/)
    await reconnect(page, seeded.targetId)
    expect(await terminalTabIds(page, seeded.worktreeId)).toEqual(
      expect.arrayContaining([first, fresh])
    )
    await expectTerminalAnswers(page, fresh)
    await page.screenshot({ path: testInfo.outputPath('managed-reconnect-panes.png') })
  })
})

/** Samples until the tab set agrees three times running, so a late restore cannot slip past. */
async function settledTabIds(page: Page, worktreeId: string): Promise<string[]> {
  let previous = ''
  let agreements = 0
  let latest: string[] = []
  await expect
    .poll(
      async () => {
        latest = (await terminalTabIds(page, worktreeId)).sort()
        const key = JSON.stringify(latest)
        agreements = key === previous && latest.length > 0 ? agreements + 1 : 0
        previous = key
        return agreements >= 2
      },
      { timeout: 120_000, intervals: [2_000] }
    )
    .toBe(true)
  return latest
}

test('managed tabs restore exactly once, and a tab closed while disconnected stays closed', async (// oxlint-disable-next-line no-empty-pattern -- Owns its app launch through a restart session.
{}, testInfo) => {
  test.setTimeout(15 * 60_000)
  await withManagedHost(testInfo, async (fixture) => {
    const launched = await launchManagedWorkspace(fixture)
    const { seeded, environmentId } = launched
    let page = launched.page
    const opened = [
      await openTerminalTab(page, seeded.worktreeId),
      await openTerminalTab(page, seeded.worktreeId),
      await openTerminalTab(page, seeded.worktreeId)
    ]
    const marker = await echoMarker(page, opened[0], 'RESTORE_MARKER')
    const expected = await settledTabIds(page, seeded.worktreeId)
    expect(expected).toEqual(expect.arrayContaining(opened))

    for (let cycle = 0; cycle < 2; cycle += 1) {
      page = await relaunchManagedApp(fixture)
      await activateManagedWorkspace(page, seeded.worktreeId, environmentId)
      expect(await settledTabIds(page, seeded.worktreeId), `relaunch ${cycle + 1}`).toEqual(
        expected
      )
      await selectTerminalTab(page, opened[0])
      await expectPaneText(page, opened[0], marker)
    }

    // A renderer reload remounts every restored tab onto its own shell.
    await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')))
    await page.reload()
    await waitForSessionReady(page, 60_000)
    await activateManagedWorkspace(page, seeded.worktreeId, environmentId)
    expect(await settledTabIds(page, seeded.worktreeId)).toEqual(expected)
    for (const tabId of opened) {
      await expectTerminalAnswers(page, tabId)
    }
    await expectPaneText(page, opened[0], marker)

    // The lid-closed shape: close a tab while disconnected, then reconnect.
    const closed = opened[2]
    await page.evaluate((targetId) => window.api.ssh.disconnect({ targetId }), seeded.targetId)
    // Use the real tab X to queue disconnected close; bare store close previously passed only by silently redialing.
    const closedTab = page.locator(`[data-testid="sortable-tab"][data-tab-id="${closed}"]`).first()
    await closedTab.hover()
    await closedTab.getByRole('button', { name: /^Close tab /i }).click()
    await expect(closedTab).toHaveCount(0, { timeout: 15_000 })
    await reconnect(page, seeded.targetId)
    const remaining = expected.filter((id) => id !== closed)
    expect(await settledTabIds(page, seeded.worktreeId)).toEqual(remaining)
    const final = await relaunchManagedApp(fixture)
    await activateManagedWorkspace(final, seeded.worktreeId, environmentId)
    expect(await settledTabIds(final, seeded.worktreeId)).toEqual(remaining)
  })
})

test('a managed pane outlives a dropped SSH link and a frozen host', async (// oxlint-disable-next-line no-empty-pattern -- Owns its app launch through a restart session.
{}, testInfo) => {
  test.setTimeout(15 * 60_000)
  await withManagedHost(testInfo, async (fixture) => {
    const { page, seeded } = await launchManagedWorkspace(fixture)
    const tabId = await openTerminalTab(page, seeded.worktreeId)
    const marker = await echoMarker(page, tabId, 'FAULT_MARKER')

    expect(fixture.host.dropSshConnections!()).toBeGreaterThan(0)
    await expectTerminalAnswers(page, tabId, 180_000)
    await expectPaneText(page, tabId, marker)

    // Silence, not a reset: the client must call the host lost instead of wedging on it.
    fixture.host.setFrozen!(true)
    try {
      await expect
        .poll(() => sshStatus(page, seeded.targetId), { timeout: 120_000, intervals: [2_000] })
        .not.toBe('connected')
    } finally {
      fixture.host.setFrozen!(false)
    }
    await reconnect(page, seeded.targetId)
    await selectTerminalTab(page, tabId)
    await expectTerminalAnswers(page, tabId, 180_000)
    await expectPaneText(page, tabId, marker)
    await page.screenshot({ path: testInfo.outputPath('managed-fault-recovery.png') })
  })
})
