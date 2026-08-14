import type { TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { getActiveTabId, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  getTerminalContent,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { waitForTabParked } from './helpers/terminal-hidden-parking'
import {
  cleanupDockerSshRelayTarget,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import { createAndActivateDockerSshRelayWorktree } from './helpers/docker-ssh-relay-worktree-activation'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const PARKING_DELAY_MS = Number(process.env.ORCA_E2E_TERMINAL_PARKING_DELAY_MS) || 500

test.use({
  // Why no seeded local repo: matching every green Docker SSH spec — the same
  // mid-session repo-add misroute hits a remote repo added beside a local one.
  seedTestRepo: false,
  orcaAppExtraEnv: {
    ORCA_E2E_TERMINAL_PARKING_DELAY_MS: String(PARKING_DELAY_MS),
    // Why limit=1: two hidden un-parkable worktrees then exceed the budget while
    // the last-active exemption still spares exactly one — the smallest live proof.
    ORCA_E2E_TERMINAL_RETENTION_LIMIT: '1'
  }
})

// C1 slice B: hidden worktrees ordinary parking can never evict (here: SSH with
// slice A's terminalSshViewParking off) force-park beyond the retention budget,
// least-recently-hidden first, and reveal restores content from the relay replay.
test.describe('terminal hidden-worktree retention budget', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'Docker SSH parking uses POSIX SSH tooling.')

  test('force-parks the older hidden un-parkable worktree and spares the newest', async ({
    orcaPage
  }, testInfo: TestInfo) => {
    test.setTimeout(240_000)
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      await waitForSessionReady(orcaPage)

      const older = await connectDockerSshRelayTarget(orcaPage, target)
      await expect
        .poll(() => waitForActiveWorktree(orcaPage), { timeout: 30_000 })
        .toBe(older.worktreeId)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      const olderPtyId = await waitForActivePanePtyId(orcaPage, 60_000)
      const olderTabId = await getActiveTabId(orcaPage)
      if (!olderTabId) {
        throw new Error('older SSH terminal tab did not become active')
      }
      // Why the ':' terminator: match the exact echoed line, not the typed command.
      const olderMarker = `RETENTION_OLD_${Date.now()}`
      await sendToTerminal(orcaPage, olderPtyId, `echo "${olderMarker}:"\r`)
      await expect
        .poll(() => getTerminalContent(orcaPage, 20_000), {
          timeout: 30_000,
          message: 'older worktree marker did not render before hiding'
        })
        .toContain(`${olderMarker}:`)

      // Why: with SSH view parking off, SSH ptys are not park-restorable, so the
      // hidden remote worktrees join the un-parkable class the budget governs.
      // Written after the first terminal is live so it cannot race target setup;
      // parking eligibility reads it at verdict time, not spawn time.
      await orcaPage.evaluate(async () => {
        await window.__store?.getState().updateSettings({ terminalSshViewParking: false })
      })

      // Why worktrees of ONE remote repo: the retention budget ranks worktrees,
      // and a repo added mid-session misroutes its pty spawn to the local daemon
      // (pre-existing multi-repo issue, independent of retention).
      // Activating the second worktree hides the older one, making the older the
      // least-recently-hidden candidate.
      const newer = await createAndActivateDockerSshRelayWorktree(
        orcaPage,
        older.repoId,
        'retention-newer'
      )
      await expect
        .poll(() => waitForActiveWorktree(orcaPage), { timeout: 30_000 })
        .toBe(newer.worktreeId)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      await waitForActivePanePtyId(orcaPage, 60_000)
      const newerTabId = await getActiveTabId(orcaPage)
      if (!newerTabId) {
        throw new Error('newer SSH terminal tab did not become active')
      }

      // Third context: activating it hides BOTH earlier worktrees — two hidden
      // un-parkable worktrees against a budget of one. It stays visible, so it
      // is never a retention candidate itself.
      const third = await createAndActivateDockerSshRelayWorktree(
        orcaPage,
        older.repoId,
        'retention-third'
      )
      await expect
        .poll(() => waitForActiveWorktree(orcaPage), { timeout: 30_000 })
        .toBe(third.worktreeId)
      await waitForActiveTerminalManager(orcaPage, 60_000)

      // The older worktree must force-park (its pane managers unmount)…
      await waitForTabParked(orcaPage, olderTabId, { parkDelayMs: PARKING_DELAY_MS })
      // …while the newest hidden worktree keeps its mounted panes (last-active exemption).
      const newerStillMounted = await orcaPage.evaluate(
        (tabId) => window.__paneManagers?.get(tabId) !== undefined,
        newerTabId
      )
      expect(newerStillMounted).toBe(true)

      // Reveal the evicted worktree: with SSH parking disabled the model paint is
      // off, so the relay replay must restore the marker tail — never a blank pane.
      await orcaPage.evaluate(
        ({ worktreeId, tabId }) => {
          const state = window.__store?.getState()
          state?.setActiveWorktree(worktreeId)
          state?.setActiveTab(tabId)
          state?.setActiveTabType('terminal')
        },
        { worktreeId: older.worktreeId, tabId: olderTabId }
      )
      await waitForActiveTerminalManager(orcaPage, 60_000)
      await expect
        .poll(() => getTerminalContent(orcaPage, 20_000), {
          timeout: 60_000,
          message: 'revealed evicted worktree did not restore the marker via relay replay'
        })
        .toContain(`${olderMarker}:`)
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })
})
