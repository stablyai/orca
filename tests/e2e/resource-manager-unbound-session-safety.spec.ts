/**
 * E2E regression for #8459 — Resource Manager force-killed live daemon sessions as "orphans".
 *
 * The incident: a packaged `orca serve` still owned live AI terminals after the GUI quit. On
 * relaunch the renderer's binding map had not caught up, so those sessions rendered as unbound.
 * "Kill orphan terminals" then destroyed them with no confirmation dialog.
 *
 * The unit tests in `resource-session-bindings.test.ts` cover the binding gap directly. This suite
 * covers the part unit tests structurally cannot: that a real warm-reattached session, surviving a
 * real quit/relaunch against a real daemon, is not classified as killable before restore completes.
 *
 * What it deliberately does not cover:
 *   - The SSH deferred-reattach path itself. That needs a remote host; the unit test drives that
 *     input shape directly.
 *   - Clicking through the confirmation dialog. Covered by the component's own tests.
 */

import { existsSync, readFileSync } from 'node:fs'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import {
  discoverActivePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'
import {
  ensureTerminalVisible,
  getStoreState,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'

/**
 * Every binding source Resource Manager consults, mirroring buildResourceSessionBindingIndex. A
 * session missing from all of them is what the popover calls an orphan.
 */
async function collectBoundSessionIds(page: Page): Promise<string[]> {
  const [ptyIdsByTabId, tabsByWorktree, layouts, deferredSsh] = await Promise.all([
    getStoreState<Record<string, string[]>>(page, 'ptyIdsByTabId'),
    getStoreState<Record<string, { ptyId?: string | null }[]>>(page, 'tabsByWorktree'),
    getStoreState<Record<string, { ptyIdsByLeafId?: Record<string, string> }>>(
      page,
      'terminalLayoutsByTabId'
    ),
    getStoreState<Record<string, string>>(page, 'deferredSshSessionIdsByTabId')
  ])
  const bound = new Set<string>()
  for (const ids of Object.values(ptyIdsByTabId ?? {})) {
    for (const id of ids ?? []) {
      bound.add(id)
    }
  }
  for (const tabs of Object.values(tabsByWorktree ?? {})) {
    for (const tab of tabs ?? []) {
      if (tab.ptyId) {
        bound.add(tab.ptyId)
      }
    }
  }
  for (const layout of Object.values(layouts ?? {})) {
    for (const id of Object.values(layout?.ptyIdsByLeafId ?? {})) {
      bound.add(id)
    }
  }
  for (const id of Object.values(deferredSsh ?? {})) {
    bound.add(id)
  }
  return [...bound]
}

test.describe.configure({ mode: 'serial' })

test.describe('Resource Manager unbound-session safety', () => {
  test('a warm-reattached session is bound after restore, so orphan cleanup cannot target it', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
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

      const firstLaunchSessions = await firstLaunch.page.evaluate(async () =>
        window.api.pty.listSessions()
      )
      expect(firstLaunchSessions.some((s) => s.id === ptyId)).toBe(true)

      // The daemon is a detached fork, so this PTY outlives the GUI — the #8459 precondition.
      await session.close(firstApp)
      firstApp = null

      const secondLaunch = await session.launch()
      secondApp = secondLaunch.app
      await waitForSessionReady(secondLaunch.page)

      // The session must still be alive on the daemon; otherwise the assertion below would pass
      // for the wrong reason.
      await expect
        .poll(
          async () =>
            secondLaunch.page.evaluate(async (expected: string) => {
              const sessions = await window.api.pty.listSessions()
              return sessions.some((s) => s.id === expected)
            }, ptyId),
          {
            timeout: 20_000,
            message: 'Warm-reattached session never appeared in the daemon session list'
          }
        )
        .toBe(true)

      // The real assertion: once restore reports ready, a live session must be bound. An unbound
      // live session is precisely what "Kill orphan terminals" would have destroyed.
      await expect
        .poll(async () => getStoreState<boolean>(secondLaunch.page, 'workspaceSessionReady'), {
          timeout: 30_000,
          message: 'Workspace session never reported ready in the relaunched window'
        })
        .toBe(true)

      const classification = await collectBoundSessionIds(secondLaunch.page).then((ids) =>
        ids.includes(ptyId)
      )

      expect(
        classification,
        'A live warm-reattached session was unbound after restore completed; orphan cleanup would target it'
      ).toBe(true)

      // Ownership evidence must survive the real IPC boundary, not just the unit-test mock: a
      // structured-clone drop or preload contract mismatch would surface here as undefined.
      // Asserting the exact arm matters — a stub returning a constant would satisfy a typeof check.
      const ownership = await secondLaunch.page.evaluate(async (expected: string) => {
        const sessions = await window.api.pty.listSessions()
        return sessions.filter((s) => s.id === expected).map((s) => s.agentOwnership)
      }, ptyId)
      expect(
        ownership,
        'pty:listSessions did not report a valid agentOwnership arm across the real IPC boundary'
      ).toHaveLength(1)
      expect(
        ['present', 'absent', 'unknown'],
        'agentOwnership crossed IPC as an unrecognized value'
      ).toContain(ownership[0])

      // A plain shell under the live local provider must be PROVEN unowned, not merely unknown —
      // otherwise the tri-state would be reporting "unknown" for everything and proving nothing.
      expect(
        ownership[0],
        'The live local provider reported non-authoritative ownership for its own session'
      ).toBe('absent')
    } finally {
      if (firstApp) {
        await session.close(firstApp).catch(() => {})
      }
      if (secondApp) {
        await session.close(secondApp).catch(() => {})
      }
    }
  })
})
