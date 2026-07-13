/**
 * E2E regression test for the reattach mouse-mode leak fixed alongside #7329.
 *
 * Why this suite exists:
 *   A TUI that armed mouse tracking (?1000/1002/1003 + SGR 1006/1016) and died
 *   uncleanly never emits the disable sequence. The daemon's private-mode
 *   tracker keeps the mode and buildRehydrateSequences re-arms it on every
 *   reattach, but POST_REPLAY_REATTACH_RESET used to clear cursor/focus/kitty
 *   state and NOT mouse modes. A plain shell in the reattached pane then echoed
 *   every pointer-motion report (`<35;col;rowM`) as literal text.
 *
 * What it covers (full stack, no mocks):
 *   - First launch arms the leak for real: a fixture writes the enable sequence
 *     to stdout and exits, and the live pane is asserted to enter mouse-reporting
 *     mode (the byte flow the daemon's tracker also records and re-arms).
 *   - After a warm reattach, the renderer terminal ends with mouse reporting
 *     DISARMED: mouseTrackingMode is 'none', the enable-mouse-events class is
 *     gone, and real pointer motion produces zero mouse reports.
 *   - A positive control re-arms the same modes and confirms the motion probe
 *     does observe reports, so the "zero reports" assertion cannot pass vacuously.
 *
 * What it does NOT cover:
 *   - That the daemon's buildRehydrateSequences re-arms the mode on reattach —
 *     locked by repro-7329-remote-snapshot-corruption.test.ts against the real
 *     serializer + xterm. This suite proves the reset half end to end.
 *   - Live-agent panes keeping mouse via POST_REPLAY_LIVE_AGENT_REATTACH_RESET
 *     (unit-tested in pty-connection.test.ts).
 */

import { existsSync, readFileSync } from 'node:fs'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import {
  discoverActivePtyId,
  execInTerminal,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForTerminalOutput
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'

// Why: quit→relaunch against the same userDataDir relies on the daemon
// surviving the first close; serial keeps the shared profile from competing
// with other Electron instances for the same lock.
test.describe.configure({ mode: 'serial' })

test.describe('reattach mouse-mode leak', () => {
  test('warm reattach disarms mouse modes a killed TUI left armed', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
  {}, testInfo) => {
    // Why: arms the leak with a POSIX `printf` builtin; the reset logic under
    // test is platform-agnostic, so skipping Windows here loses no coverage.
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
      // ── First launch: arm the leak through the real daemon ─────────────
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

      // Gate on real command execution before arming: the `$((21+21))` result
      // only appears if the shell evaluated it (the echoed command text shows
      // the expression, not `42`). Some sandboxed CI/dev runners spawn a PTY
      // that echoes input but never execs a shell; skip there rather than fail,
      // matching the pane-manager guard above — there is nothing to arm.
      await execInTerminal(firstLaunch.page, ptyId, 'echo ORCA_MOUSE_READY_$((21+21))')
      const shellExecutes = await waitForTerminalOutput(
        firstLaunch.page,
        'ORCA_MOUSE_READY_42',
        15_000
      )
        .then(() => true)
        .catch(() => false)
      test.skip(!shellExecutes, 'PTY shell does not execute commands in this environment')

      // Arm mouse tracking exactly as a TUI would, then let the shell foreground
      // return — the disable is never sent, so the daemon's tracker keeps the
      // mode and re-arms it on reattach. printf is a shell builtin (no external
      // binary), and its typed argument is literal backslashes, so only real
      // execution emits the ESC bytes that arm xterm below.
      await execInTerminal(firstLaunch.page, ptyId, `printf '\\033[?1003h\\033[?1006h'`)

      // Precondition: the printf armed real mouse reporting in the live
      // pane (proving the leak's byte flow reached the terminal). The daemon's
      // tracker sees the same output stream and re-arms this mode on every
      // reattach — the rehydrate half is locked by the repro-7329 unit test; this
      // suite proves the reattach reset disarms it end to end.
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

      // Why: app.close flushes beforeunload, but the daemon is a detached fork
      // so the PTY (and its armed mouse mode) survives for the warm reattach.
      await session.close(firstApp)
      firstApp = null

      // ── Second launch: reattach must disarm the leaked modes ────────────
      const secondLaunch = await session.launch()
      secondApp = secondLaunch.app
      await waitForSessionReady(secondLaunch.page)
      await waitForActiveWorktree(secondLaunch.page)
      await ensureTerminalVisible(secondLaunch.page)
      await waitForActiveTerminalManager(secondLaunch.page, 30_000)
      await waitForPaneCount(secondLaunch.page, 1, 30_000)

      // The reattach replay re-arms mouse via rehydrate, then the reset must
      // clear it. Poll until it settles to 'none' (times out if the reset
      // regresses to not touching mouse modes).
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

      // Behavioral proof + positive control: real pointer motion must produce
      // no reports post-reattach, but the same probe DOES observe reports once
      // mouse mode is re-armed — so the "zero reports" result is not vacuous.
      const probe = await secondLaunch.page.evaluate(async () => {
        // An SGR mouse report is `ESC [ < params (M|m)`; the `ESC [ <` prefix is
        // unambiguous, so substring matching avoids a control-char regex.
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
          // Why: xterm binds the enable-mouse-events class AND the motion
          // listener together in one _handleProtocolChange pass, so poll a bounded
          // number of frames — dispatching motion each round — until arming takes
          // rather than reading a single frame that can precede the binding.
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
            armedReports,
            // Whether the reattached pane dynamically bound xterm mouse reporting
            // at all — class and listener attach together, so either signal proves it.
            armedMouseReporting: classAfterArm || armedReports > 0
          }
        } finally {
          disposable.dispose()
        }
      })

      // Post-reattach the pane is fully disarmed.
      expect(probe.afterReattach.mode).toBe('none')
      expect(probe.afterReattach.hasEnableMouseClass).toBe(false)
      expect(probe.afterReattach.reports).toBe(0)
      // Why: the positive control needs the reattached pane to dynamically bind
      // xterm's browser MouseService. Some headless CI renderers never do on a warm
      // reattach — the core mouseTrackingMode still flips but no DOM class/listener
      // attaches — so arming is impossible and the probe can't run. Skip there,
      // matching the pane-manager/shell guards above; the reset invariant stays
      // covered by repro-7329 + pty-connection unit tests and this suite on macOS.
      test.skip(
        !probe.armedMouseReporting,
        'Reattached pane does not dynamically bind xterm mouse reporting in this environment'
      )
      // Positive control proves the motion probe genuinely detects reports.
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
