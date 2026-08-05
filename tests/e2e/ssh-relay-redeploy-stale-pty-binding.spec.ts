// STA-3077 / #11729 regression guard.
//
// Scenario: an SSH relay dies abruptly (SIGTERM, no graceful UI disconnect --
// simulates a real network drop or relay crash) while 3 terminal panes are
// live, then the app reconnects. Docker-traced fact (see the project memory
// for the full run): on relay death, Orca's own auto-redeploy starts a FRESH
// relay process with a new pid and a RESET internal pty-id counter -- the
// remote shells the old leases point at are genuinely gone. This is NOT a
// "panes should be restored" scenario; no fix can bring back a destroyed
// shell, and asserting recovered pane count would be asserting something
// false by design.
//
// What IS in scope, and what this spec guards: `handlePtyReattachFailure`
// never runs for this path (traced: zero "Dropping stale PTY" / "Leaving PTY
// ... detached" / "Ignoring stale PTY" log lines across the whole run, loss
// completing ~27ms after ssh.connect() resolves), so nothing retires the old
// leases or scrubs their bindings. Two invariants should hold regardless:
//   1. every lease still in a reattach-eligible state ('attached'/'detached'
//      -- exactly the reattachKnownPtys eligibility filter) after the app
//      settles must back a currently-visible pane. NOT keyed on `createdAt`:
//      the fresh relay resets its pty-id counter, and upsert deliberately
//      preserves `existing.createdAt` when a re-minted id lands on a retired
//      row, so "unchanged createdAt" flags legitimate fresh leases as stale.
//   2. no visible pane may display a binding whose lease is not live -- that
//      binding points at a shell that no longer exists.
// Ground truth (D7): the durably recorded relay incarnation must change
// across the kill, proving the redeploy really produced a new generation.
//
// Empirical hit rate (4 runs, see project-sta3077-ssh-pane-duplication
// memory): all 3 pre-drop SSH panes were lost every run (4/4). The specific
// leftover-stale-binding signature (a pre-drop ptyId still present in the
// pane manager after the 45s settle window) showed up in 3/4 runs; the 4th
// collapsed further (0 visible panes at all, stale ref gone too). Both
// outcomes satisfy invariant 2 as written (no *currently visible* pane may
// carry a stale binding) and this spec asserts invariant 1 unconditionally.
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'
import {
  connectDockerSshRelayTarget,
  reconnectDisconnectedDockerSshRelayTarget
} from './helpers/docker-ssh-relay-connection'
import {
  cleanupDockerSshRelayTarget,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import {
  readDockerSshRelayProcessSnapshot,
  terminateDockerSshRelay,
  isDockerSshRelayPidRunning
} from './helpers/docker-ssh-relay-processes'
import {
  readPersistedTerminalLayout,
  type PersistedTerminalLayout
} from './helpers/persisted-terminal-layout'
import { parseAppSshPtyId, toAppSshPtyId } from '../../src/shared/ssh-pty-id'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  countVisibleTerminalPanes,
  splitActiveTerminalPane,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
// Loss completes well under a second per the trace, but leave generous
// margin for the redeploy + app reconnect RPC chain to fully settle.
const SETTLE_SAMPLE_WINDOW_MS = 45_000
const SETTLE_SAMPLE_INTERVAL_MS = 2_000

type SshLease = {
  targetId: string
  ptyId: string
  tabId?: string
  leafId?: string
  state: 'attached' | 'detached' | 'terminated' | 'expired'
  createdAt: number
  updatedAt: number
}

test.describe('SSH relay redeploy: stale PTY bindings', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH repro.')
  test.skip(process.platform === 'win32', 'Docker SSH repro uses POSIX SSH tooling.')

  test('leases from a destroyed relay generation are retired and no visible pane keeps their binding', async ({
    orcaPage,
    electronApp
  }, testInfo) => {
    test.setTimeout(360_000)
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const remote = await connectDockerSshRelayTarget(orcaPage, target, {
        relayGracePeriodSeconds: 300
      })
      await waitForActiveTerminalManager(orcaPage, 60_000)
      await waitForActivePanePtyId(orcaPage, 60_000)

      // Build out 3 panes in the single tab so we have multiple live remote PTYs.
      await splitActiveTerminalPane(orcaPage, 'vertical')
      await waitForPaneCount(orcaPage, 2, 30_000)
      await splitActiveTerminalPane(orcaPage, 'horizontal')
      await waitForPaneCount(orcaPage, 3, 30_000)

      const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
      // Why this path, not userDataDir/orca-data.json: the bare path is only
      // the fresh-install onboarding seed. The running app's live writes land
      // under the profile directory -- reading the bare path here previously
      // silently returned leasesAfter: null on every run.
      const dataFile = path.join(userDataDir, 'profiles', 'local-default', 'orca-data.json')
      const readLeases = (): SshLease[] => {
        const raw = JSON.parse(readFileSync(dataFile, 'utf8'))
        return (raw.sshRemotePtyLeases ?? []).filter(
          (l: { targetId: string }) => l.targetId === remote.targetId
        )
      }
      const readLayout = (tabId: string | undefined): PersistedTerminalLayout | null =>
        tabId === undefined ? null : readPersistedTerminalLayout(dataFile, tabId)
      const readIncarnation = (): { targetId: string; pid: number; token?: string } | null => {
        const raw = JSON.parse(readFileSync(dataFile, 'utf8'))
        return (
          (raw.sshRelayIncarnations ?? []).find(
            (entry: { targetId: string }) => entry.targetId === remote.targetId
          ) ?? null
        )
      }
      const readPaneState = async (): Promise<{
        count: number
        ptyIds: (string | undefined)[]
      }> => {
        const count = await countVisibleTerminalPanes(orcaPage)
        const ptyIds = await orcaPage.evaluate(() => {
          const managers = Array.from(window.__paneManagers?.values() ?? [])
          return managers.flatMap((m) => m.getPanes?.().map((p) => p.container.dataset.ptyId) ?? [])
        })
        return { count, ptyIds }
      }

      const paneCountBefore = await countVisibleTerminalPanes(orcaPage)
      const leasesBefore = readLeases()
      const tabIdBefore = leasesBefore[0]?.tabId
      const layoutBefore = readLayout(tabIdBefore)
      // A missing layout would make the leaf-count guard below compare 0 <= 0 forever.
      expect(
        layoutBefore,
        'the tab must have a persisted layout in some workspace-session partition'
      ).not.toBeNull()
      const leafCountBefore = Object.keys(layoutBefore?.ptyIdsByLeafId ?? {}).length
      // D7 records the incarnation synchronously at connect, so it is already on disk here.
      const incarnationBefore = readIncarnation()
      expect(
        incarnationBefore,
        'the connect must durably record the relay incarnation it attached to'
      ).not.toBeNull()

      const beforeSnapshot = readDockerSshRelayProcessSnapshot(target)
      if (!beforeSnapshot) {
        throw new Error('No relay process group found before kill')
      }

      // Kill the relay WITHOUT a graceful UI disconnect first -- mimics a real
      // network drop / relay crash, not a user-initiated disconnect.
      terminateDockerSshRelay(target, beforeSnapshot)
      await expect
        .poll(() => isDockerSshRelayPidRunning(target!, beforeSnapshot.relayPid), {
          timeout: 30_000,
          message: 'relay did not exit after SIGTERM'
        })
        .toBe(false)

      // App-driven reconnect WITHOUT first calling disconnect (mirrors an
      // auto-reconnect / "resume connection" flow after detecting a drop).
      await reconnectDisconnectedDockerSshRelayTarget(orcaPage, remote.targetId)
      await waitForActiveTerminalManager(orcaPage, 60_000)

      // Sample repeatedly over a long window -- the relay reconnect backoff
      // sequence can take well past a few seconds to fully settle after an
      // abrupt drop.
      const timeline: { atMs: number; count: number; ptyIds: (string | undefined)[] }[] = []
      const start = Date.now()
      while (Date.now() - start < SETTLE_SAMPLE_WINDOW_MS) {
        const state = await readPaneState()
        timeline.push({ atMs: Date.now() - start, ...state })
        await orcaPage.waitForTimeout(SETTLE_SAMPLE_INTERVAL_MS)
      }

      // Why wait THEN flush: the renderer's session patch is debounced (~150ms) and main
      // re-debounces its disk write; flushing first and waiting after would let a change
      // produced at the end of the sampling loop reach disk only after the read below.
      await orcaPage.waitForTimeout(1_500)
      await orcaPage.evaluate(() => window.api.session.flush())

      const finalState = await readPaneState()
      // The per-connection relay watcher comes and goes independently of the persistent
      // relay, and the snapshot helper needs both — poll instead of sampling once.
      await expect
        .poll(() => readDockerSshRelayProcessSnapshot(target!)?.relayPid ?? null, {
          timeout: 30_000,
          message: 'relay must redeploy after SIGTERM'
        })
        .not.toBeNull()
      const afterSnapshot = readDockerSshRelayProcessSnapshot(target)
      const leasesAfter = readLeases()
      const layoutAfter = readLayout(tabIdBefore)
      const incarnationAfter = readIncarnation()

      const evidence = {
        remoteTargetId: remote.targetId,
        paneCountBefore,
        leafCountBefore,
        leasesBefore,
        layoutBefore,
        beforeSnapshot,
        timeline,
        finalState,
        afterSnapshot,
        leasesAfter,
        layoutAfter,
        incarnationBefore,
        incarnationAfter
      }
      console.log(`[ssh-relay-redeploy-stale-pty-binding] ${JSON.stringify(evidence, null, 2)}`)
      testInfo.annotations.push({
        type: 'ssh-relay-redeploy-stale-pty-binding',
        description: JSON.stringify(evidence)
      })

      // Ground truth: SIGTERM + redeploy must actually produce a fresh relay
      // process. If this fails, the scenario didn't execute as designed.
      expect(afterSnapshot, 'relay must redeploy after SIGTERM').not.toBeNull()
      expect(
        afterSnapshot!.relayPid,
        'redeployed relay must be a different process, not a respawn of the same pid'
      ).not.toBe(beforeSnapshot.relayPid)
      // D7 ground truth: the reconnect must have recorded the fresh generation, or every
      // lease assertion below would be testing the pre-D7 code path.
      expect(
        incarnationAfter,
        'the reconnect must durably record the fresh relay incarnation'
      ).not.toBeNull()
      if (incarnationBefore!.token !== undefined && incarnationAfter!.token !== undefined) {
        expect(
          incarnationAfter!.token,
          'the recorded incarnation token must change across the relay kill'
        ).not.toBe(incarnationBefore!.token)
      } else {
        expect(
          incarnationAfter!.pid,
          'the recorded incarnation pid must change across the relay kill'
        ).not.toBe(incarnationBefore!.pid)
      }

      // Invariant 1: 'attached'/'detached' is exactly the eligibility filter
      // reattachKnownPtys uses, so any lease still in either state after the
      // settle must back a currently-visible pane. NOT keyed on createdAt --
      // upsert preserves `existing.createdAt` when the fresh relay's reset
      // counter re-mints an id, so unchanged createdAt cannot separate a
      // stale row from a legitimate fresh lease.
      const visiblePtyIds = new Set(finalState.ptyIds.filter((id): id is string => Boolean(id)))
      const danglingRestorableLeases = leasesAfter.filter(
        (lease) =>
          (lease.state === 'attached' || lease.state === 'detached') &&
          // Derive the composite id through the main process's own encoder: hardcoding the
          // format would make this filter silently empty if the format ever changed.
          !visiblePtyIds.has(toAppSshPtyId(lease.targetId, lease.ptyId))
      )
      expect(
        danglingRestorableLeases,
        'every lease still eligible for reattach must back a visible pane; the rest must be retired (expired/terminated)'
      ).toEqual([])

      // Invariant 2: no currently-visible pane may display a binding whose
      // lease is not live -- that binding points at a shell that no longer
      // exists on the redeployed relay.
      const attachedCompositeIds = new Set(
        leasesAfter
          .filter((lease) => lease.state === 'attached')
          .map((lease) => toAppSshPtyId(lease.targetId, lease.ptyId))
      )
      const zombieVisibleBindings = [...visiblePtyIds].filter(
        (id) =>
          parseAppSshPtyId(id)?.connectionId === remote.targetId && !attachedCompositeIds.has(id)
      )
      expect(
        zombieVisibleBindings,
        'no visible pane may display a binding without a live (attached) lease behind it'
      ).toEqual([])

      // Durable layout guard: the leaf/pty binding table must not gain extra
      // leaves during this recovery path (that would be RC3's split-and-graft
      // signature -- it's the duplication defect, not this loss scenario, but
      // it's cheap to guard here too since the layout is captured either way).
      // Same reason as the `layoutBefore` guard: a vanished layout would satisfy the
      // leaf-count comparison for the wrong reason.
      expect(
        layoutAfter,
        'the tab must still have a persisted layout after the redeploy settles'
      ).not.toBeNull()
      const leafCountAfter = Object.keys(layoutAfter!.ptyIdsByLeafId).length
      expect(
        leafCountAfter,
        'reconnect after a relay redeploy must not graft additional leaves into the layout'
      ).toBeLessThanOrEqual(leafCountBefore)
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })
})
