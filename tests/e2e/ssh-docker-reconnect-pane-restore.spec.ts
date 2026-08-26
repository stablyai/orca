import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  getTerminalContent,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import {
  cleanupDockerSshRelayTarget,
  enableDockerSshRelayTargetShellTitle,
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
 * The two regressions this covers both shipped and both reached a user, because nothing here
 * asserted what a pane actually SHOWS after a reconnect:
 *
 * 1. Panes came back blank. The relay treated the reconnecting client as one that already held the
 *    stream and returned no scrollback, while the renderer had disposed the xterm with its buffer.
 * 2. A tab created afterwards came up with no prompt and stayed generically titled, because the
 *    reconnect prepaint could still fire on a spent mount.
 *
 * Reading the pane's own text is the point. Asserting a pty id, a status, or a spy call is what let
 * both of these through: every one of those was correct while the screen was wrong.
 *
 * KNOWN: (1) is fixed at the symptom. requireReplay makes the client ask for what the relay wrongly
 * decided it did not need. Three attempts at the cause failed, and the reasons are worth keeping
 * because each looks correct until you run it:
 *
 * - RETIRING THE DELIVERY ON dispatcher.onClientDetached, the way fs-handler, git-handler and
 *   relay-filesystem-watch-registry release their per-client state, BREAKS CHECKPOINT RECOVERY (10
 *   tests in relay-pty-source-recovery-interleavings / restore-retry). A delivery outliving its
 *   client is deliberate here: it is what lets a reconnecting client resume from a checkpoint
 *   instead of re-receiving everything. This class omits that subscription on purpose.
 * - RETIRING WITHOUT session.cancelDelivery() orphans the credit ledger's one-upstream-owner-per-pty
 *   slot, and the next open throws "PTY source delivery already has an upstream owner". Seen live as
 *   an error toast and a blank pane.
 * - COMPARING record.identity.clientGeneration TO THE REQUEST is not available: that value is
 *   client-supplied through pty.openClient (dispatcher.ts:1219) and RequestContext carries no
 *   generation of its own.
 *
 * The real cause is now established, and it is broader than this spec: a reconnect reuses the same
 * clientId (setWrite keeps the primary client), so the relay's activate() matches on it and returns
 * 'existing' before ever reaching the recovery branch. Checkpointed source recovery therefore has
 * never run on an SSH reconnect at all, and the byte tail is not a fallback but the only path. Full
 * chain and the fix it implies: docs/reference/ssh-reconnect-source-recovery.md.
 */
test.describe('SSH reconnect pane restore', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run the dockerized SSH relay tests')

  test('restores shell scrollback, a full-screen frame, and a usable new tab across a reconnect', async ({
    orcaPage
  }, testInfo) => {
    test.slow()
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      // The fixture image's shell emits no OSC 0, so without this every tab keeps its placeholder
      // title regardless of shell health and the title assertion below could never pass.
      enableDockerSshRelayTargetShellTitle(target)
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const remote = await connectDockerSshRelayTarget(orcaPage, target)
      await ensureTerminalVisible(orcaPage, 45_000)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      const ptyId = await waitForActivePanePtyId(orcaPage, 60_000)

      // A marker rather than a prompt: a prompt reappears on its own after a reconnect, so it cannot
      // distinguish restored scrollback from a fresh shell. This string only exists if the pane kept
      // what it had.
      const marker = `RECONNECT_MARKER_${Date.now()}`
      await execInTerminal(orcaPage, ptyId, `echo ${marker}`)
      await waitForTerminalOutput(orcaPage, marker, 30_000)

      await reconnectDockerSshRelayTarget(orcaPage, remote.targetId)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      await waitForActivePanePtyId(orcaPage, 60_000)

      // REGRESSION 1: the pane painted nothing at all here, because the relay withheld the replay.
      await waitForTerminalOutput(orcaPage, marker, 60_000)

      // A FULL-SCREEN app is the second case: a reconnect must leave a TUI pane alive and drawing,
      // not blank or frozen.
      //
      // Deliberately run in the ORIGINAL tab, and deliberately BEFORE the new-tab case below. A tab
      // created after a reconnect is destroyed by an unrelated session-sync bug on the next one (see
      // ssh-reconnect-tab-destruction.spec.ts), so staging the TUI there conflated two failures and
      // left this guard red for a reason that has nothing to do with painting. This tab predates
      // every reconnect, so it is in the host snapshot and survives.
      //
      // SCOPE, because it is easy to over-read: this does NOT prove which payload painted the pane.
      // top redraws itself every few seconds, so these assertions pass whichever way the paint-source
      // gate decided — including with it reverted. What discriminates model-vs-tail is unit-level, in
      // ssh-reconnect-model-paint-gate.test.ts, because the interesting cases are disagreements
      // between main's pre-outage alt-screen belief and a replay produced during the outage, which
      // is not something this fixture can stage. Kept anyway: it is the only coverage that a
      // reconnected TUI pane recovers at all.
      await execInTerminal(orcaPage, ptyId, 'top -b -n 1 > /dev/null; top')
      await waitForTerminalOutput(orcaPage, 'load average', 30_000, 8000)

      await reconnectDockerSshRelayTarget(orcaPage, remote.targetId)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      await waitForActivePanePtyId(orcaPage, 60_000)

      await waitForTerminalOutput(orcaPage, 'load average', 60_000, 8000)
      const tuiContent = await getTerminalContent(orcaPage, 8000)
      expect(tuiContent).toContain('PID')

      // REGRESSION 2: opening a tab AFTER a reconnect. The prepaint could still fire on this mount
      // and write over the new shell, leaving a pane with no prompt and a generic tab title.
      await openTerminalTabInActiveGroup(orcaPage)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      const freshPtyId = await waitForActivePanePtyId(orcaPage, 60_000)
      expect(freshPtyId).not.toBe(ptyId)

      // The new pane must reach a shell that answers, which is what "usable" means and what a blank
      // pane fails. Echoing proves the shell read input and wrote back, not merely that a pty exists.
      const freshMarker = `NEW_TAB_MARKER_${Date.now()}`
      await execInTerminal(orcaPage, freshPtyId, `echo ${freshMarker}`)
      await waitForTerminalOutput(orcaPage, freshMarker, 60_000)

      // And it must be a FRESH shell, not a repaint of the old pane's history.
      const freshContent = await getTerminalContent(orcaPage, 8000)
      expect(freshContent).not.toContain(marker)

      // The title is the cheap signal the reported bug showed: it only stays generic when the shell
      // never printed a prompt for Orca to read one from.
      await expect
        .poll(
          async () =>
            orcaPage.evaluate(() => {
              const store = window.__store
              const state = store?.getState()
              const worktreeId = state?.activeWorktreeId
              if (!state || !worktreeId) {
                return null
              }
              const activeTabId = state.activeTabIdByWorktree?.[worktreeId]
              const tabs = state.tabsByWorktree?.[worktreeId] ?? []
              return tabs.find((tab) => tab.id === activeTabId)?.title ?? null
            }),
          { timeout: 60_000, message: 'New tab kept its placeholder title' }
        )
        .not.toMatch(/^Terminal \d+$/)
    } finally {
      if (target) {
        cleanupDockerSshRelayTarget(target)
      }
    }
  })
})
