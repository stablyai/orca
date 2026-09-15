import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePanePtyId, waitForActiveTerminalManager } from './helpers/terminal'
import {
  cleanupDockerSshRelayTarget,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import {
  connectDockerSshRelayTarget,
  reconnectDockerSshRelayTarget
} from './helpers/docker-ssh-relay-connection'
import { openTerminalTabInActiveGroup } from './helpers/terminal-tab-open'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'

/**
 * A terminal opened right after an SSH reconnect must come up with a live shell.
 *
 * Mechanism (measured, not inferred): the reconnect's pane-retry ledger bumps `tab.generation` on
 * every target tab that has no PTY yet — which a tab created seconds after the reconnect is. The
 * bump remounts the pane while its first spawn is still in flight; main's pane-spawn reservation
 * hands the remounted pane the SAME PTY the first spawn is about to receive; and the disposed first
 * transport then killed that PTY as an orphan. Two symptoms from one kill: a proven exit closes the
 * tab outright, a synthetic exit leaves the tab bound to a dead shell that never answers input.
 *
 * Why rounds: the window is a race with the reconnect, so one green round proves nothing. Before
 * the fix this failed 4-5 rounds in 10 across four independent 10-round runs; after it, 0 in 30.
 * Six rounds put a lucky pass on the unfixed code below 5%.
 */
const ROUNDS = 6
const PANE_BIND_TIMEOUT_MS = 45_000
const ECHO_TIMEOUT_MS = 20_000

async function readPaneContent(
  page: Parameters<typeof openTerminalTabInActiveGroup>[0],
  tabId: string
): Promise<string> {
  return page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    return pane?.serializeAddon?.serialize?.() ?? ''
  }, tabId)
}

test.describe('SSH reconnect new-tab liveness', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run the dockerized SSH relay tests')

  test('a tab opened right after a reconnect gets a shell that answers', async ({
    orcaPage
  }, testInfo) => {
    test.setTimeout(ROUNDS * 120_000)
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const remote = await connectDockerSshRelayTarget(orcaPage, target)
      await ensureTerminalVisible(orcaPage, 45_000)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      await waitForActivePanePtyId(orcaPage, 60_000)

      for (let round = 1; round <= ROUNDS; round += 1) {
        await reconnectDockerSshRelayTarget(orcaPage, remote.targetId)
        // Deliberately no wait for the reconnected pane to rebind: the race needs the new tab's
        // first spawn to still be in flight when the reconnect ledger bumps its generation.
        const priorTabId = await orcaPage.evaluate(() => window.__store?.getState().activeTabId)
        await openTerminalTabInActiveGroup(orcaPage)
        const newTabId = await orcaPage.evaluate(() => window.__store?.getState().activeTabId)
        expect(newTabId, `round ${round}: no tab was opened`).toBeTruthy()
        // Without this the round could measure the prior (already live) tab instead of the new one.
        expect(newTabId, `round ${round}: the active tab is not a new tab`).not.toBe(priorTabId)

        let ptyId: string | null = null
        await expect
          .poll(
            async () =>
              orcaPage.evaluate((tabId) => {
                const state = window.__store!.getState()
                const worktreeId = state.activeWorktreeId
                const survived = worktreeId
                  ? (state.tabsByWorktree[worktreeId] ?? []).some((tab) => tab.id === tabId)
                  : false
                const manager = window.__paneManagers?.get(tabId)
                const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
                return { survived, ptyId: pane?.container?.dataset?.ptyId ?? null }
              }, newTabId!),
            {
              timeout: PANE_BIND_TIMEOUT_MS,
              message: `round ${round}: the new tab never bound a PTY`
            }
          )
          .toMatchObject({ survived: true, ptyId: expect.any(String) })
        ptyId = await orcaPage.evaluate((tabId) => {
          const manager = window.__paneManagers?.get(tabId)
          const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
          return pane?.container?.dataset?.ptyId ?? null
        }, newTabId!)

        const marker = `LIVE_${round}_${Date.now()}`
        await orcaPage.evaluate(({ ptyId, text }) => window.api.pty.write(ptyId, text), {
          ptyId: ptyId!,
          text: `echo ${marker}\r`
        })
        // The marker shows once as the echoed command line and once as the command's output, so
        // a shell that only echoes keystrokes back does not count as live.
        await expect
          .poll(async () => (await readPaneContent(orcaPage, newTabId!)).split(marker).length > 2, {
            timeout: ECHO_TIMEOUT_MS,
            message: `round ${round}: the new tab's shell did not answer a command`
          })
          .toBe(true)
      }
    } finally {
      if (target) {
        cleanupDockerSshRelayTarget(target)
      }
    }
  })
})
