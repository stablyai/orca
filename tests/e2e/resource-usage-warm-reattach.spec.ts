// #1667: a warm daemon PTY must appear in the local memory snapshot with a real PID before second-launch pane mount.
// Also check local connectionId/view-model inputs so missing registry hydration cannot mislabel the workspace as remote; SSH merge behavior is unit-tested.

import { existsSync, readFileSync } from 'node:fs'
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

// Run serially so restart keeps the same profile/daemon socket without competing app locks.
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

      // Require the daemon session before quit so relaunch has real warm state.
      const firstLaunchSessions = await firstLaunch.page.evaluate(async () => {
        return window.api.pty.listSessions()
      })
      expect(firstLaunchSessions.some((s) => s.id === ptyId)).toBe(true)

      // App close runs beforeunload but leaves the detached daemon alive, the warm-reattach precondition.
      await session.close(firstApp)
      firstApp = null

      const secondLaunch = await session.launch()
      secondApp = secondLaunch.app
      await waitForSessionReady(secondLaunch.page)

      // Poll through async boot hydration and provider.listSessions before judging the snapshot.
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
      // Require the real collector row/PID; merge fallback alone can synthesize a metric-less row.
      expect(warmRow!.pid).not.toBeNull()
      expect(warmRow!.pid! > 0).toBe(true)

      // Verify local connectionId and merged inputs without depending on an off-screen popover; unit tests pin its predicate.
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
      await session.dispose()
    }
  })
})
