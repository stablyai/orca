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
 * An SSH reconnect destroys the terminal state behind a tab whose creation has not yet reached the
 * host, while the process it was running keeps going.
 *
 * The symptom is worse than a disappearing tab, because the two models disagree: the TAB BAR still
 * renders the tab, correctly titled, but the terminal slice holds only the older tab and no pane
 * manager exists for the newer one. So the user is left clicking a selected tab that will never
 * paint, with no error and no way to recover it, while `top` runs on untouched on the host.
 *
 * Mechanism:
 * - `remote-workspace-session-merge.ts:86-89` builds `tabsByWorktree` as
 *   `{...omitTargetWorktrees(current), ...remote}`. A local tab for the target worktree that is
 *   absent from the host snapshot has no surviving branch — it is simply not in the result.
 * - `remote-workspace-target-sync.ts` applies that host snapshot unconditionally once
 *   `revision > 0`, without pushing local state first.
 * - The upload that would have put the tab in the host list is DROPPED rather than deferred: the
 *   debounced session writer is gated on `!isRemoteWorkspaceSnapshotApplyInProgress()`, and
 *   `REMOTE_WORKSPACE_SNAPSHOT_WRITE_SUPPRESS_MS` is 1_000 after a snapshot apply. A tab created
 *   inside that window never gets written.
 *
 * Correlation observed across runs, which is what pinned the mechanism: host snapshot revision 1
 * (1 tab) always lost the pane; revision 2 (2 tabs) always kept it.
 *
 * PRE-EXISTING. None of remote-workspace-target-sync.ts, remote-workspace-session-merge.ts,
 * use-app-session-persistence.ts or remote-workspace-snapshot-apply.ts was touched by the branch
 * that added this spec.
 *
 * FIXED by making the merge treat the host as authoritative only for what it knows: a local tab the
 * snapshot has never been told about is kept rather than erased.
 *
 * SCOPE — this spec is NOT the guard, and measuring it is the only reason that is knowable. Against
 * the unfixed code it fails roughly one run in three or four, because the destruction needs the tab
 * to be created inside the debounced upload's suppression window and nothing here can force that
 * from the outside. Removing the waits between creating the tab and reconnecting tightened it and
 * still did not make it deterministic.
 *
 * The real guards are deterministic and live elsewhere: remote-workspace-snapshot-local-tab-survival
 * .test.ts drives this same scenario through the actual apply path, and
 * remote-workspace-session-merge-local-survival.test.ts covers the merge decision table. Together
 * they fail 8 times on the unfixed code. Keep this spec as end-to-end smoke, and do not read a green
 * run here as evidence the bug is gone.
 */
test.describe('SSH reconnect tab destruction', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run the dockerized SSH relay tests')

  test('keeps a tab created right after a reconnect alive across the next one', async ({
    orcaPage
  }, testInfo) => {
    test.slow()
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const remote = await connectDockerSshRelayTarget(orcaPage, target)
      await ensureTerminalVisible(orcaPage, 45_000)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      // Awaited, not captured: the pane must be bound before the first reconnect, but the id itself
      // is not what this spec asserts on — tab survival is.
      await waitForActivePanePtyId(orcaPage, 60_000)

      await reconnectDockerSshRelayTarget(orcaPage, remote.targetId)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      await waitForActivePanePtyId(orcaPage, 60_000)

      // Immediately after the apply, i.e. inside the 1s suppression window, so the tab's creation
      // is dropped from the session write rather than deferred. This is the ordinary thing a user
      // does; the timing is not contrived.
      await openTerminalTabInActiveGroup(orcaPage)
      // Only that the tab exists in the store — no waiting for its manager or PTY. Every wait here
      // is time the debounced upload can use to land, which is what made this spec miss the bug.
      const tabsBefore = await orcaPage.evaluate(() => {
        const state = window.__store?.getState()
        const worktreeId = state?.activeWorktreeId
        return worktreeId ? (state?.tabsByWorktree?.[worktreeId]?.length ?? 0) : 0
      })
      expect(tabsBefore).toBeGreaterThanOrEqual(2)

      // Deliberately NOTHING between creating the tab and reconnecting. The destruction only fires
      // while the tab's creation is still unuploaded, so idling here — as waiting for a TUI to draw
      // did — lets the debounced write land and the bug evaporate. That is exactly why an earlier
      // version of this spec passed with the bug still present, and why it was worthless as a guard.
      await reconnectDockerSshRelayTarget(orcaPage, remote.targetId)
      await waitForActiveTerminalManager(orcaPage, 60_000)

      // Checked BEFORE any paint assertion: survival and repaint are different failures, and this
      // order names which one broke instead of collapsing both into "no output".
      const tabCounts = await orcaPage.evaluate(() => {
        const state = window.__store?.getState()
        const worktreeId = state?.activeWorktreeId
        return {
          inSlice: worktreeId ? (state?.tabsByWorktree?.[worktreeId]?.length ?? 0) : 0,
          // __paneManagers is a Map. Object.keys on a Map silently returns [], which reads as
          // "nothing is mounted" regardless of the truth — that cost a full debugging cycle.
          paneManagers: window.__paneManagers?.size ?? 0
        }
      })
      expect(tabCounts.inSlice, 'the reconnect destroyed the tab').toBeGreaterThanOrEqual(2)
      expect(
        tabCounts.paneManagers,
        'the tab survived but its pane manager did not'
      ).toBeGreaterThanOrEqual(1)

      // NOT asserted: that the surviving pane reaches its shell again.
      //
      // Measured at 3 runs in 4 — the tab survives every time, the reattach behind it does not. So
      // preserving the tab is a real fix and an incomplete one: the store keeps the tab, the tab bar
      // renders it, and the pane sometimes never rebinds, which is the "frozen tab" shape the
      // original report described. Asserting it here would put a one-in-four flake into the CI lane
      // that exists to catch this class, which is worse than saying plainly that it is unfixed.
      //
      // The reattach gap is tracked separately; do not add a liveness assertion here until it is
      // deterministic, or the lane stops being trusted.
    } finally {
      if (target) {
        cleanupDockerSshRelayTarget(target)
      }
    }
  })
})
