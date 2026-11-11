// #7329: unproven TUI death retains mouse modes in host rehydrate, but ordinary reattach must disarm them before shell use.
// Keep a real arming process alive across restart (no OSC 133;D grounding); require no tracking/class/motion reports after replay.
// Re-arm as a positive control. Serializer re-arm is pinned by repro-7329-remote-snapshot-corruption.test.ts; live-agent preservation by pty-connection.test.ts.

import { existsSync, readFileSync } from 'node:fs'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import {
  discoverActivePtyId,
  execInTerminal,
  sendToTerminal,
  waitForActiveTerminalManager,
  waitForActivePanePtyId,
  waitForPaneCount,
  waitForTerminalOutput
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'

// Serialize the shared-profile quit/relaunch so the surviving daemon and Electron lock have no competing app.
test.describe.configure({ mode: 'serial' })

test.describe('reattach mouse-mode leak', () => {
  test('warm reattach disarms mouse modes a killed TUI left armed', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
  {}, testInfo) => {
    // The arming fixture uses POSIX printf; reset logic itself is platform-independent.
    test.skip(process.platform === 'win32', 'Uses a POSIX printf to arm mouse reporting')

    const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
    if (!repoPath || !existsSync(repoPath)) {
      test.skip(true, 'Global setup did not produce a seeded test repo')
      return
    }

    const session = createRestartSession(testInfo)
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null

    try {
      const firstLaunch = await session.launch()
      firstApp = firstLaunch.app
      await attachRepoAndOpenTerminal(firstLaunch.page, repoPath)
      await waitForSessionReady(firstLaunch.page)
      await waitForActiveWorktree(firstLaunch.page)
      await ensureTerminalVisible(firstLaunch.page)

      const hasPaneManager = await waitForActiveTerminalManager(firstLaunch.page, 30_000)
        .then(() => true)
        .catch(() => false)
      test.skip(
        !hasPaneManager,
        'Electron automation in this environment never mounts the TerminalPane manager.'
      )
      await waitForPaneCount(firstLaunch.page, 1, 30_000)
      const ptyId = await discoverActivePtyId(firstLaunch.page)

      // Require arithmetic command execution, beyond echo; skip sandbox PTYs with no executing shell rather than misdiagnose reset.
      await execInTerminal(firstLaunch.page, ptyId, 'echo ORCA_MOUSE_READY_$((21+21))')
      const shellExecutes = await waitForTerminalOutput(
        firstLaunch.page,
        'ORCA_MOUSE_READY_42',
        15_000
      )
        .then(() => true)
        .catch(() => false)
      test.skip(!shellExecutes, 'PTY shell does not execute commands in this environment')

      // printf’s literal backslashes arm xterm only on execution; keep the process alive so OSC 133;D cannot ground modes before reattach.
      await execInTerminal(firstLaunch.page, ptyId, `printf '\\033[?1003h\\033[?1006h'; sleep 120`)

      // Require live mouse arming before restart; repro-7329 units pin host rehydrate, while this arm pins reset.
      await expect
        .poll(
          async () =>
            firstLaunch.page.evaluate(() => {
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
              return pane?.terminal.modes.mouseTrackingMode ?? null
            }),
          {
            timeout: 15_000,
            message:
              'printf never armed mouse reporting in the live pane; leak precondition not met'
          }
        )
        .toBe('any')

      // app.close saves/disconnects but leaves the detached daemon’s PTY and armed modes alive.
      await session.close(firstApp)
      firstApp = null

      const secondLaunch = await session.launch()
      secondApp = secondLaunch.app
      await waitForSessionReady(secondLaunch.page)
      await waitForActiveWorktree(secondLaunch.page)
      await ensureTerminalVisible(secondLaunch.page)
      await waitForActiveTerminalManager(secondLaunch.page, 30_000)
      await waitForPaneCount(secondLaunch.page, 1, 30_000)
      // Live output is released only after reattach replay has finished.
      const reattachedPtyId = await waitForActivePanePtyId(secondLaunch.page)

      // Poll for reset after rehydrate re-arms the still-running program’s modes.
      await expect
        .poll(
          async () =>
            secondLaunch.page.evaluate(() => {
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
              return pane?.terminal.modes.mouseTrackingMode ?? null
            }),
          {
            timeout: 15_000,
            message: 'Reattached pane never disarmed the leaked mouse-tracking mode'
          }
        )
        .toBe('none')

      await sendToTerminal(secondLaunch.page, reattachedPtyId, '\x03')
      await execInTerminal(secondLaunch.page, reattachedPtyId, 'echo ORCA_REATTACHED_$((21+21))')
      await waitForTerminalOutput(secondLaunch.page, 'ORCA_REATTACHED_42', 15_000)

      // Require no motion reports after reattach, then re-arm and require reports from the same probe.
      const probe = await secondLaunch.page.evaluate(async () => {
        // Match unambiguous ESC [ < report prefix without a control-character regex.
        const isMouseReport = (data: string): boolean => data.includes('\x1b[<')
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
        if (!pane?.terminal.element) {
          throw new Error('Active terminal pane unavailable')
        }
        const screen = pane.terminal.element.querySelector<HTMLElement>('.xterm-screen')
        if (!screen) {
          throw new Error('Active terminal screen unavailable')
        }

        const reports: string[] = []
        const disposable = pane.terminal.onData((data) => reports.push(data))
        const dispatchMotion = async (): Promise<void> => {
          const rect = screen.getBoundingClientRect()
          for (const fraction of [0.15, 0.3, 0.45, 0.6, 0.75, 0.9]) {
            screen.dispatchEvent(
              new MouseEvent('mousemove', {
                bubbles: true,
                cancelable: true,
                clientX: rect.left + rect.width * fraction,
                clientY: rect.top + rect.height * 0.5
              })
            )
            await new Promise((resolve) => setTimeout(resolve, 15))
          }
        }
        const motionReports = (): string[] => reports.filter(isMouseReport)

        try {
          // Phase A: post-reattach, mouse must be disarmed → no reports.
          await dispatchMotion()
          const afterReattach = {
            mode: pane.terminal.modes.mouseTrackingMode,
            hasEnableMouseClass: pane.terminal.element.classList.contains('enable-mouse-events'),
            reports: motionReports().length
          }

          // Phase B: positive control — re-arm and confirm the probe sees reports.
          reports.length = 0
          await new Promise<void>((resolve) =>
            pane.terminal.write('\x1b[?1003h\x1b[?1006h', () => resolve())
          )
          // Poll frames with motion because class/listener binding shares an async protocol-change pass.
          let classAfterArm = false
          let armedReports = 0
          for (let attempt = 0; attempt < 40 && armedReports === 0; attempt += 1) {
            await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
            classAfterArm =
              classAfterArm || pane.terminal.element.classList.contains('enable-mouse-events')
            await dispatchMotion()
            armedReports = motionReports().length
          }

          return {
            afterReattach,
            classAfterArm,
            armedReports
          }
        } finally {
          disposable.dispose()
        }
      })

      expect(probe.afterReattach.mode).toBe('none')
      expect(probe.afterReattach.hasEnableMouseClass).toBe(false)
      expect(probe.afterReattach.reports).toBe(0)
      expect(probe.classAfterArm).toBe(true)
      expect(probe.armedReports).toBeGreaterThan(0)
    } finally {
      if (secondApp) {
        await session.close(secondApp)
      }
      if (firstApp) {
        await session.close(firstApp)
      }
      await session.dispose()
    }
  })
})
