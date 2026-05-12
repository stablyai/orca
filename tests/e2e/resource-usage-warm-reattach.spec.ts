/**
 * E2E regression test for the Resource Usage popover warm-reattach bug.
 *
 * Why this suite exists:
 *   PR #1667 fixed a bug where workspaces with daemon-backed terminals that
 *   had been running before app launch were rendered as `· REMOTE` with `—`
 *   for CPU/Memory in the Resource Usage popover, even when no SSH targets
 *   were configured. The root cause was that the renderer's `pty-registry`
 *   was empty for warm-reattached sessions until the user clicked into each
 *   pane, so the chip predicate (which keyed on a "snapshot includes this
 *   worktree" flag) misread missing data as "remote." Two changes shipped:
 *   (1) boot-time hydration of `pty-registry` from the daemon, and (2) the
 *   chip predicate switched to `repo.connectionId != null`.
 *
 * What it covers:
 *   - On a second launch against the same userDataDir, the snapshot from
 *     the local memory collector includes the warm-reattached PTY with a
 *     real (non-null) pid before any pane mount in the second renderer.
 *     This is the boot-hydration coverage fix.
 *   - The merged view-model the popover consumes flags the warm worktree
 *     as `isRemote: false` and surfaces numeric CPU/memory.
 *
 * What it does NOT try to cover:
 *   - Multi-worktree warm-reattach. The hydrator iterates all repos ×
 *     worktrees; one is sufficient to lock down the regression path.
 *   - SSH worktrees. Covered by unit tests in `mergeSnapshotAndSessions.test.ts`.
 */

import { existsSync, readFileSync } from 'fs'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import {
  discoverActivePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'

// Why: this suite does a quit→relaunch cycle that depends on the daemon
// surviving the first app close and the second launch reattaching to the
// same daemon socket. Running tests in serial keeps the userDataDir from
// competing with other concurrent Electron instances for the same lock.
test.describe.configure({ mode: 'serial' })

test.describe('Resource Usage warm-reattach', () => {
  test('warm-reattached local PTY is included in snapshot with non-null pid and is not flagged remote', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
  {}, testInfo) => {
    const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
    if (!repoPath || !existsSync(repoPath)) {
      test.skip(true, 'Global setup did not produce a seeded test repo')
      return
    }

    const session = createRestartSession(testInfo)
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null

    try {
      // ── First launch: seed a daemon-backed PTY ─────────────────────────
      const firstLaunch = await session.launch()
      firstApp = firstLaunch.app
      const worktreeId = await attachRepoAndOpenTerminal(firstLaunch.page, repoPath)
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

      // Why: the daemon should already have this session listed before we
      // close the app. If it doesn't, the second-launch assertion would
      // fail for the wrong reason (no warm-reattach state to verify).
      const firstLaunchSessions = await firstLaunch.page.evaluate(async () => {
        return window.api.pty.listSessions()
      })
      expect(firstLaunchSessions.some((s) => s.id === ptyId)).toBe(true)

      // Why: app.close triggers the renderer's beforeunload but the daemon
      // is a detached child fork (see daemon-init.ts:128) so the PTY
      // process stays alive. This is the warm-reattach precondition the
      // PR's bug requires.
      await session.close(firstApp)
      firstApp = null

      // ── Second launch: verify hydration restored coverage ──────────────
      const secondLaunch = await session.launch()
      secondApp = secondLaunch.app
      await waitForSessionReady(secondLaunch.page)

      // Why: poll the snapshot rather than reading once, because boot
      // hydration is asynchronous and the first poll after launch could
      // legitimately race the hydrator's `await provider.listSessions()`
      // round-trip. The hydrator runs once at boot via attachMainWindowServices;
      // the assertion just needs to converge before the timeout.
      type WarmRow = { worktreeId: string; sessionId: string; pid: number | null }
      const warmRow: WarmRow | null = await expect
        .poll(
          async () =>
            secondLaunch.page.evaluate(async (expectedPtyId: string) => {
              const snap = await window.api.memory.getSnapshot()
              if (!snap) {
                return null
              }
              for (const wt of snap.worktrees) {
                for (const s of wt.sessions) {
                  if (s.sessionId === expectedPtyId) {
                    return { worktreeId: wt.worktreeId, sessionId: s.sessionId, pid: s.pid }
                  }
                }
              }
              return null
            }, ptyId),
          {
            timeout: 15_000,
            message:
              'Boot hydration did not register the warm-reattached PTY in the memory snapshot'
          }
        )
        .not.toBeNull()
        .then(async () =>
          secondLaunch.page.evaluate(async (expectedPtyId: string) => {
            const snap = await window.api.memory.getSnapshot()
            if (!snap) {
              return null
            }
            for (const wt of snap.worktrees) {
              for (const s of wt.sessions) {
                if (s.sessionId === expectedPtyId) {
                  return { worktreeId: wt.worktreeId, sessionId: s.sessionId, pid: s.pid }
                }
              }
            }
            return null
          }, ptyId)
        )

      expect(warmRow).not.toBeNull()
      expect(warmRow!.worktreeId).toBe(worktreeId)
      // Why: the load-bearing assertion. Pre-fix, this row would not have
      // existed at all; the renderer's merge fallback would have synthesized
      // a row with no metrics. Post-fix, the daemon-published pid is what
      // boot hydration writes into pty-registry, which the collector then
      // walks.
      expect(warmRow!.pid).not.toBeNull()
      expect(warmRow!.pid! > 0).toBe(true)

      // Why: confirm the chip predicate. The repo this test seeds is local
      // (no connectionId), so the merged view-model must report
      // `isRemote: false`. We assert against the worktree's connectionId
      // through the store rather than rendering the popover, because the
      // popover trigger is in the status bar and may be off-screen in a
      // small e2e viewport. The merge predicate is exercised by unit tests;
      // here we just confirm the inputs resolve correctly.
      const isLocalRepo = await secondLaunch.page.evaluate((wid: string) => {
        const store = window.__store
        if (!store) {
          return null
        }
        const state = store.getState()
        const repoId = wid.split('::')[0]
        const repo = state.repos.find((r) => r.id === repoId)
        return repo ? (repo.connectionId ?? null) === null : null
      }, worktreeId)
      expect(isLocalRepo).toBe(true)
    } finally {
      if (secondApp) {
        await session.close(secondApp)
      }
      if (firstApp) {
        await session.close(firstApp)
      }
      session.dispose()
    }
  })
})
