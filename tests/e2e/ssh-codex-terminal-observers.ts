import type { Page } from '@stablyai/playwright-test'
import { expect } from './helpers/orca-app'
import { ensureTerminalVisible, switchToWorktree } from './helpers/store'
import {
  execInTerminal,
  sendToTerminal,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { REMOTE_CODEX_FIXTURE_CLEAN_FINAL_TEXT } from './ssh-codex-repro-remote-fixtures'
import { switchToNonRemoteWorktree } from './ssh-codex-reconnect-replay-driver'

export async function waitForRemoteFixtureCleanFinalInHiddenPane(
  page: Page,
  remoteWorktreeId: string
): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(
          ({ remoteWorktreeId, cleanFinalText }) => {
            const state = window.__store?.getState()
            const tabId = state?.activeTabIdByWorktree?.[remoteWorktreeId] ?? null
            const manager = tabId ? window.__paneManagers?.get(tabId) : null
            const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
            return pane?.serializeAddon?.serialize?.().includes(cleanFinalText) === true
          },
          { remoteWorktreeId, cleanFinalText: REMOTE_CODEX_FIXTURE_CLEAN_FINAL_TEXT }
        ),
      {
        timeout: 180_000,
        message: 'Remote fixture did not reach its clean final frame while hidden'
      }
    )
    .toBe(true)
}

export async function waitForRealRemoteCodexCompletion(
  page: Page,
  doneMarker: string
): Promise<void> {
  await expect
    .poll(
      async () => {
        const content = await page.evaluate(() => {
          const state = window.__store?.getState()
          const worktreeId = state?.activeWorktreeId
          const tabId =
            state?.activeTabType === 'terminal'
              ? state.activeTabId
              : worktreeId
                ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
                : null
          const manager = tabId ? window.__paneManagers?.get(tabId) : null
          const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
          return pane?.serializeAddon?.serialize?.() ?? ''
        })
        return content.split(doneMarker).length - 1
      },
      {
        timeout: 300_000,
        message: 'Real remote Codex did not emit its final marker'
      }
    )
    .toBeGreaterThanOrEqual(2)
}

export async function clearRemoteTerminalAfterCodex(
  page: Page,
  ptyId: string,
  cleanMarker: string
): Promise<void> {
  await sendToTerminal(page, ptyId, '/quit\r')
  await waitForTerminalOutput(page, 'root@', 20_000, 120_000)
  await execInTerminal(
    page,
    ptyId,
    `printf '\\033[2J\\033[H${cleanMarker}\\nREAL_CODEX_CLEAN_SCREEN\\n'`
  )
  await waitForTerminalOutput(page, cleanMarker, 20_000, 120_000)
}

export async function waitForRealRemoteCodexBackgroundStatus(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const content = await page.evaluate(() => {
          const state = window.__store?.getState()
          const worktreeId = state?.activeWorktreeId
          const tabId =
            state?.activeTabType === 'terminal'
              ? state.activeTabId
              : worktreeId
                ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
                : null
          const manager = tabId ? window.__paneManagers?.get(tabId) : null
          const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
          return pane?.serializeAddon?.serialize?.() ?? ''
        })
        return /background terminal|Working for background terminal|REMOTE_CODEX_PHASE/i.test(
          content
        )
      },
      {
        timeout: 180_000,
        message: 'Real remote Codex did not enter the long-running background-command state'
      }
    )
    .toBe(true)
}

export async function scrollActiveTerminalToArtifactHistory(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      throw new Error('No active terminal pane to scroll')
    }
    const historyDepth = pane.terminal.buffer.active.baseY
    pane.terminal.scrollToLine(Math.max(0, historyDepth - pane.terminal.rows * 3))
    pane.terminal.refresh(0, pane.terminal.rows - 1)
  })
  await page.waitForTimeout(800)
}

export async function stressRestoreRemoteTerminalDuringCodex(
  page: Page,
  remoteWorktreeId: string
): Promise<void> {
  for (let cycle = 0; cycle < 5; cycle += 1) {
    await switchToNonRemoteWorktree(page, remoteWorktreeId)
    await page.waitForTimeout(8_000)
    await switchToWorktree(page, remoteWorktreeId)
    await ensureTerminalVisible(page, 45_000)
    await waitForActiveTerminalManager(page, 60_000)
    await waitForRealRemoteCodexBackgroundStatus(page)
    await page.waitForTimeout(900)
  }
}
