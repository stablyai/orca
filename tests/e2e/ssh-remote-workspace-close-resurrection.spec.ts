/**
 * E2E repro for #10342 / PR #12339: terminal tabs closed while an SSH target
 * is disconnected must stay closed after the target reconnects.
 *
 * The failing path on main: `syncAfterConnect` pulls the relay workspace
 * snapshot on every reconnect and replaces local tab state whenever the
 * snapshot revision is > 0 — even when the snapshot did not change since this
 * client last synced. Tabs closed while offline never reached the relay
 * mirror, so the pull resurrects them in the tab bar.
 */
import { test, expect } from './helpers/orca-app'
import type { Page } from '@stablyai/playwright-test'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePanePtyId, waitForActiveTerminalManager } from './helpers/terminal'
import {
  cleanupDockerSshRelayTarget,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  execDockerSshRelayTargetCommand,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import {
  connectDockerSshRelayTarget,
  disconnectDockerSshRelayTarget,
  reconnectDisconnectedDockerSshRelayTarget
} from './helpers/docker-ssh-relay-connection'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const TAB_COUNT = 3
const SORTABLE_TAB = '[data-testid="sortable-tab"]'

test.use({ seedTestRepo: false })

async function createRemoteTerminalTab(page: Page, worktreeId: string): Promise<void> {
  const tabId = await page.evaluate((id) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('Store unavailable')
    }
    const tab = state.createTab(id, undefined, undefined, { activate: true })
    state.setActiveTab(tab.id)
    state.setActiveTabType('terminal')
    return tab.id
  }, worktreeId)
  await expect
    .poll(() => page.evaluate(() => window.__store?.getState().activeTabId ?? null), {
      timeout: 10_000
    })
    .toBe(tabId)
  await waitForActiveTerminalManager(page, 60_000)
  await waitForActivePanePtyId(page, 60_000)
}

async function readWorktreeTabIds(page: Page, worktreeId: string): Promise<string[]> {
  return page.evaluate(
    (id) => (window.__store?.getState().tabsByWorktree[id] ?? []).map((tab) => tab.id),
    worktreeId
  )
}

async function readRenderedTabIds(page: Page): Promise<string[]> {
  return page.evaluate(
    (selector) =>
      Array.from(document.querySelectorAll(selector))
        .map((tab) => tab.getAttribute('data-tab-id') ?? '')
        .filter(Boolean),
    SORTABLE_TAB
  )
}

test.describe('SSH remote workspace close resurrection', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'Docker SSH tests use POSIX SSH tooling.')

  test('tabs closed while disconnected stay closed after reconnect', async ({
    orcaPage
  }, testInfo) => {
    test.setTimeout(240_000)
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      await waitForSessionReady(orcaPage)
      const remote = await connectDockerSshRelayTarget(orcaPage, target)
      await expect
        .poll(() => waitForActiveWorktree(orcaPage), { timeout: 30_000 })
        .toBe(remote.worktreeId)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      await waitForActivePanePtyId(orcaPage, 60_000)

      while ((await readWorktreeTabIds(orcaPage, remote.worktreeId)).length < TAB_COUNT) {
        await createRemoteTerminalTab(orcaPage, remote.worktreeId)
      }
      const allTabIds = await readWorktreeTabIds(orcaPage, remote.worktreeId)
      expect(allTabIds).toHaveLength(TAB_COUNT)

      // Wait until the relay snapshot mirrors every open tab — this both
      // commits the pre-close state remotely and records the last synced
      // revision the reconnect arbitration reads.
      await expect
        .poll(
          () =>
            orcaPage.evaluate(
              async ({ targetId, worktreePath }) => {
                const snapshot = await window.api.remoteWorkspace.get({ targetId })
                return (
                  snapshot?.session.tabsByWorktreePath[worktreePath]?.map((tab) => tab.id) ?? []
                )
              },
              { targetId: remote.targetId, worktreePath: DOCKER_SSH_RELAY_REMOTE_REPO_PATH }
            ),
          { timeout: 30_000, message: 'SSH tabs were not committed to the relay workspace' }
        )
        .toEqual(allTabIds)

      await disconnectDockerSshRelayTarget(orcaPage, remote.targetId)
      await expect
        .poll(
          () =>
            orcaPage.evaluate(
              (targetId) => window.__store?.getState().sshConnectionStates.get(targetId)?.status,
              remote.targetId
            ),
          { timeout: 30_000, message: 'SSH target did not disconnect' }
        )
        .not.toBe('connected')

      // Latch the push path exactly like a real stale-revision conflict does
      // (#2323 C2): App.tsx skips pushes for targets in 'conflict', so the tab
      // closes below never reach the relay mirror and the snapshot goes stale.
      await orcaPage.evaluate((targetId) => {
        window.__store?.getState().setRemoteWorkspaceSyncStatus(targetId, {
          phase: 'conflict',
          direction: 'push',
          message: 'Workspace changed on another device'
        })
      }, remote.targetId)

      // Close every tab except the first while the target is offline —
      // through the real tab-bar close buttons, like a user would.
      const survivingTabId = allTabIds[0]!
      for (const tabId of allTabIds.slice(1)) {
        const tab = orcaPage.locator(`${SORTABLE_TAB}[data-tab-id="${tabId}"]`).first()
        await tab.hover()
        await tab.getByRole('button', { name: /^Close tab /i }).click()
        await expect(tab).toHaveCount(0, { timeout: 10_000 })
      }
      expect(await readWorktreeTabIds(orcaPage, remote.worktreeId)).toEqual([survivingTabId])

      // Staleness precondition: the relay-side snapshot still holds all three
      // tabs, so the reconnect pull has stale state to (wrongly) restore.
      const staleSnapshot = execDockerSshRelayTargetCommand(
        target,
        'cat /root/.orca/sessions/*.json'
      )
      const staleTabIds = (
        JSON.parse(staleSnapshot) as {
          session: { tabsByWorktreePath: Record<string, { id: string }[]> }
        }
      ).session.tabsByWorktreePath[DOCKER_SSH_RELAY_REMOTE_REPO_PATH]?.map((tab) => tab.id)
      expect(staleTabIds).toEqual(allTabIds)

      await reconnectDisconnectedDockerSshRelayTarget(orcaPage, remote.targetId)
      await expect
        .poll(
          () =>
            orcaPage.evaluate(
              (targetId) => window.__store?.getState().sshConnectionStates.get(targetId)?.status,
              remote.targetId
            ),
          { timeout: 60_000, message: 'SSH target did not reconnect' }
        )
        .toBe('connected')

      // Wait for the post-reconnect workspace sync to settle. The arbitration
      // must upload local state (remote revision did not advance since the
      // last sync), not pull the stale snapshot — a pull here is the bug.
      await expect
        .poll(
          () =>
            orcaPage.evaluate(
              (targetId) =>
                window.__store?.getState().remoteWorkspaceSyncStatusByTargetId[targetId] ?? null,
              remote.targetId
            ),
          { timeout: 60_000, message: 'remote workspace sync did not settle after reconnect' }
        )
        .toMatchObject({ phase: 'synced', direction: 'push' })

      // The bug: the reconnect pull resurrects the two closed tabs. Give the
      // sync ample time to misbehave, then assert the DOM tab bar still shows
      // only the surviving tab.
      await orcaPage.waitForTimeout(5_000)
      expect(await readRenderedTabIds(orcaPage)).toEqual([survivingTabId])
      expect(await readWorktreeTabIds(orcaPage, remote.worktreeId)).toEqual([survivingTabId])

      // And the relay mirror converges to the surviving tab instead of
      // re-serving the stale three-tab session on the next reconnect.
      await expect
        .poll(
          () =>
            orcaPage.evaluate(
              async ({ targetId, worktreePath }) => {
                const snapshot = await window.api.remoteWorkspace.get({ targetId })
                return (
                  snapshot?.session.tabsByWorktreePath[worktreePath]?.map((tab) => tab.id) ?? []
                )
              },
              { targetId: remote.targetId, worktreePath: DOCKER_SSH_RELAY_REMOTE_REPO_PATH }
            ),
          { timeout: 30_000, message: 'relay workspace still holds the closed tabs' }
        )
        .toEqual([survivingTabId])
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })
})
