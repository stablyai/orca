import { existsSync, readFileSync } from 'node:fs'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { openFileExplorer } from './helpers/file-explorer'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import { createTerminalTabFromMenu, SORTABLE_TAB } from './helpers/terminal-tab-menu'
import {
  execInTerminal,
  focusActiveTerminalInput,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { splitMarkerEchoCommand } from './terminal-marker-echo-command'
import { PTY_SESSION_ID_SEPARATOR } from '../../src/shared/pty-session-id-format'

function seededRepoPath(): string {
  const repoPath = existsSync(TEST_REPO_PATH_FILE)
    ? readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
    : ''
  if (!repoPath || !existsSync(repoPath)) {
    throw new Error('Golden restart E2E requires the seeded test repo from global setup')
  }
  return repoPath
}

test('restores the exact file and live extra terminal after quit and relaunch @golden', async (// oxlint-disable-next-line no-empty-pattern -- this test owns both Electron launches.
{}, testInfo) => {
  test.setTimeout(300_000)
  const repoPath = seededRepoPath()
  const session = createRestartSession(testInfo)
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null

  try {
    const first = await session.launch()
    firstApp = first.app
    await waitForSessionReady(first.page)
    const primaryWorktreeId = await attachRepoAndOpenTerminal(first.page, repoPath)
    await ensureTerminalVisible(first.page)
    await waitForActiveTerminalManager(first.page, 30_000)
    const extraTerminalId = await createTerminalTabFromMenu(first.page)
    await waitForActiveTerminalManager(first.page, 30_000)
    const extraTerminalPtyId = await waitForActivePanePtyId(first.page, 30_000)
    expect(extraTerminalPtyId).toContain(PTY_SESSION_ID_SEPARATOR)
    const preQuitMarkerPrefix = 'GOLDEN_RELAUNCH_PERSISTED'
    const preQuitMarkerSuffix = `_${Date.now()}`
    const preQuitMarker = `${preQuitMarkerPrefix}${preQuitMarkerSuffix}`
    await execInTerminal(
      first.page,
      extraTerminalPtyId,
      splitMarkerEchoCommand(preQuitMarkerPrefix, preQuitMarkerSuffix)
    )
    await waitForTerminalOutput(first.page, preQuitMarker, 20_000)

    await openFileExplorer(first.page)
    const fileRow = first.page
      .locator('[data-file-explorer-row]')
      .filter({ hasText: 'package.json' })
      .first()
    await expect(fileRow).toBeVisible({ timeout: 15_000 })
    await fileRow.click()
    await expect(first.page.locator('.editor-header-path').first()).toContainText('package.json', {
      timeout: 20_000
    })
    const tabCountAtQuit = await first.page.locator(SORTABLE_TAB).count()

    await session.close(firstApp)
    firstApp = null

    const second = await session.launch()
    secondApp = second.app
    await waitForSessionReady(second.page)
    await expect(
      second.page.locator(`[role="option"][data-worktree-id="${primaryWorktreeId}"]`)
    ).toHaveAttribute('aria-current', 'page', { timeout: 30_000 })
    await expect(second.page.locator(SORTABLE_TAB)).toHaveCount(tabCountAtQuit, {
      timeout: 30_000
    })
    await expect(second.page.locator('.editor-header-path').first()).toContainText('package.json', {
      timeout: 30_000
    })

    const restoredExtraTab = second.page.locator(
      `${SORTABLE_TAB}[data-tab-id="${extraTerminalId}"]`
    )
    await expect(restoredExtraTab).toBeVisible()
    await restoredExtraTab.click({ force: true })
    await waitForActiveTerminalManager(second.page, 30_000)
    expect(await waitForActivePanePtyId(second.page, 30_000)).toBe(extraTerminalPtyId)
    await waitForTerminalOutput(second.page, preQuitMarker, 20_000)
    await expect(second.page.getByRole('button', { name: /Reconnect/i })).toHaveCount(0)
    await focusActiveTerminalInput(second.page)
    const marker = `GOLDEN_RELAUNCH_LIVE_${Date.now()}`
    const command = process.platform === 'win32' ? `Write-Output ${marker}` : `echo ${marker}`
    await second.page.keyboard.type(command)
    await second.page.keyboard.press('Enter')
    await waitForTerminalOutput(second.page, marker, 20_000)
  } finally {
    for (const app of [secondApp, firstApp]) {
      if (app) {
        await session.close(app).catch(() => undefined)
      }
    }
    await session.dispose()
  }
})
