/**
 * The reported regression, driven end to end (STA-3077).
 *
 * Reported against 1.4.182-daily.202608131439: connect to an SSH worktree, disconnect that host
 * from the hosts popup, reconnect — and every tab is gone. The reporter's screenshot showed one
 * tab left holding blank panes, which is worse than the behaviour the change set out to fix.
 *
 * Why this spec exists at all: the flow was already drivable before the regression shipped.
 * `reconnectDockerSshRelayTarget` is exactly disconnect-then-connect, and three specs already
 * called it — none asserted that the user's tabs and shells came back. The work that broke this
 * gated heavily on an unreachable-pane case and never covered the ordinary cycle a user performs,
 * which is why it passed CI and still failed in the reporter's hands.
 *
 * What is pinned:
 *   1. every tab the user opened is still there after the cycle;
 *   2. every pane is bound to a live shell, not left blank; and
 *   3. the host gained no shells — recovering must not multiply terminals, which is the defect the
 *      reverted work was originally chasing. Both properties have to hold at once, because
 *      satisfying either one alone is exactly how this regression was produced.
 */
import { expect, test } from './helpers/orca-app'
import type { Page } from '@stablyai/playwright-test'
import { getTabBarOrder, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  readPaneIdentitySnapshot,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import {
  cleanupDockerSshRelayTarget,
  execDockerSshRelayTargetCommand,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import {
  connectDockerSshRelayTarget,
  reconnectDockerSshRelayTarget
} from './helpers/docker-ssh-relay-connection'
import { createTerminalTabFromMenu } from './helpers/terminal-tab-menu'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
// Why: the relay must outlive the disconnect. Its floor is 60s anyway and a user reconnecting by
// hand is well inside that, so the shells stay alive throughout — this pins reachability, not death.
const RELAY_GRACE_PERIOD_SECONDS = 900

/**
 * Count the shells on the host, from its process table.
 *
 * Only ever compared against another reading taken the same way, so the probe's own transient
 * shell — and any other constant the image contributes — cancels out. That makes this sound as a
 * relative measure without having to pin down an exact absolute count.
 */
function countRemoteShells(target: DockerSshRelayTarget): number {
  const listed = execDockerSshRelayTargetCommand(target, `ps -eo args | grep -c '[b]ash' || true`)
  const parsed = Number.parseInt(listed.trim(), 10)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Open one terminal tab, retrying the menu.
 *
 * Why: the "+" dropdown re-renders while a remote pane is still settling, so the menu item can
 * detach between resolve and click. That flakiness belongs to the menu, not to what this spec
 * measures, and failing on it would hide the regression behind an unrelated timeout.
 */
async function openTerminalTabWithRetry(page: Page): Promise<void> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await createTerminalTabFromMenu(page)
      return
    } catch (error) {
      lastError = error
      await page.waitForTimeout(2_000)
    }
  }
  throw lastError
}

test.describe('an SSH host survives being disconnected and reconnected', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'Docker SSH E2E uses POSIX ssh tooling.')

  test('reconnecting keeps every tab, rebinds every pane, and adds no shell', async ({
    orcaPage
  }, testInfo) => {
    test.setTimeout(600_000)
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      const relayTarget = target

      await waitForSessionReady(orcaPage)
      const remote = await connectDockerSshRelayTarget(orcaPage, relayTarget, {
        relayGracePeriodSeconds: RELAY_GRACE_PERIOD_SECONDS
      })
      await expect
        .poll(() => waitForActiveWorktree(orcaPage), { timeout: 60_000 })
        .toBe(remote.worktreeId)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      await waitForActivePanePtyId(orcaPage, 60_000)

      // More than one tab, because the report is "tabs are all gone": a single-tab case cannot
      // tell losing every tab from losing all but one, and the screenshot showed one left.
      // Created through the store rather than the tab-bar menu, whose dropdown re-renders while a
      // remote pane is settling — that flakiness is not what this spec is measuring.
      for (let index = 0; index < 2; index += 1) {
        await openTerminalTabWithRetry(orcaPage)
        await waitForActivePanePtyId(orcaPage, 60_000)
      }

      const tabsBefore = await getTabBarOrder(orcaPage, remote.worktreeId)
      expect(
        tabsBefore.length,
        'the test never opened the tabs whose survival it checks'
      ).toBeGreaterThanOrEqual(3)
      const shellsBefore = countRemoteShells(relayTarget)
      expect(
        shellsBefore,
        'the host hosts no shells, so the count below would pass for the wrong reason'
      ).toBeGreaterThan(0)

      // The reported repro, verbatim: disconnect the host, then connect it again.
      await reconnectDockerSshRelayTarget(orcaPage, remote.targetId)
      await expect
        .poll(() => waitForActiveWorktree(orcaPage), { timeout: 120_000 })
        .toBe(remote.worktreeId)

      // 1. Every tab is still there.
      await expect
        .poll(() => getTabBarOrder(orcaPage, remote.worktreeId).then((tabs) => tabs.length), {
          timeout: 180_000,
          message: 'reconnecting lost tabs the user had open'
        })
        .toBe(tabsBefore.length)
      const tabsAfter = await getTabBarOrder(orcaPage, remote.worktreeId)
      expect(
        [...tabsAfter].sort(),
        'reconnecting replaced the tabs rather than restoring them'
      ).toEqual([...tabsBefore].sort())

      // 2. The panes are bound to shells rather than left blank. A tab that comes back empty is
      //    the other half of the report, and it would otherwise satisfy the count above.
      await expect
        .poll(
          async () => {
            const snapshot = await readPaneIdentitySnapshot(orcaPage)
            if (!snapshot || snapshot.panes.length === 0) {
              return false
            }
            return snapshot.panes.every((pane) => pane.ptyId !== null)
          },
          { timeout: 180_000, message: 'a pane came back blank, with no shell bound to it' }
        )
        .toBe(true)

      // 3. Nothing multiplied on the host. This is the defect the reverted work was chasing, so a
      //    fix that restores tabs by spawning duplicates has to fail here.
      expect(
        countRemoteShells(relayTarget),
        'reconnecting changed how many shells the host runs'
      ).toBe(shellsBefore)
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })
})
