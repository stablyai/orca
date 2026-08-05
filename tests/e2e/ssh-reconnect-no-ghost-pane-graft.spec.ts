// STA-3077 / #11729 regression guard for D4 (durable close intent).
//
// The hazard: closing a terminal pane while the SSH transport is severed makes
// the pty:kill shutdown RPC fail, and pty.ts rethrows on purpose so the user can
// retry. Before D4 the rethrow also skipped finishPtyShutdown, so the pane's
// SshRemotePtyLease survived non-terminated -- and on reconnect
// reattachKnownPtys reattaches every non-terminated lease regardless of whether
// the renderer still has a pane for it, resurrecting the closed pane as a ghost.
// D4 records the retirement *before* the RPC, so the rethrow no longer decides
// whether the pane can come back.
//
// Why close-while-*frozen*, not close-after-a-graceful-disconnect: a graceful
// ssh:disconnect unregisters the SSH provider, so pty:kill takes the tombstone
// fast-path and retires the lease with no RPC at all -- a path that was always
// safe. Reaching the rethrow needs a provider that is still registered while its
// peer is unresponsive. So: freeze the relay (the app still believes it is
// connected), close while frozen, disconnect explicitly to tear down the mux
// (invalidating the pending shutdown rather than letting it land once
// unfrozen), then unfreeze and reconnect.
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'
import {
  connectDockerSshRelayTarget,
  disconnectDockerSshRelayTarget,
  reconnectDisconnectedDockerSshRelayTarget
} from './helpers/docker-ssh-relay-connection'
import {
  cleanupDockerSshRelayTarget,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import {
  findDockerSshRelayPid,
  freezeDockerSshRelay,
  unfreezeDockerSshRelay
} from './helpers/docker-ssh-relay-processes'
import {
  readPersistedTerminalLayout,
  type PersistedTerminalLayout
} from './helpers/persisted-terminal-layout'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  closeActiveTerminalPane,
  countVisibleTerminalPanes,
  splitActiveTerminalPane,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
// Why 25s: the bounded reattach RPC deadline is ~10s with one retry (see the freeze helper's
// comment), so a graft landing at the tail of a full retry cycle must still fall inside the window.
const RECONNECT_SAMPLE_WINDOW_MS = 25_000
const RECONNECT_SAMPLE_INTERVAL_MS = 2_000

type SshLease = {
  targetId: string
  ptyId: string
  tabId?: string
  leafId?: string
  state: 'attached' | 'detached' | 'terminated' | 'expired'
  createdAt: number
  updatedAt: number
}

test.describe('SSH reconnect: closed panes stay closed', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH repro.')
  test.skip(process.platform === 'win32', 'Docker SSH repro uses POSIX SSH tooling.')

  test('a pane closed while the relay is unresponsive must not come back on reconnect', async ({
    orcaPage,
    electronApp
  }, testInfo) => {
    test.setTimeout(300_000)
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

      // Two panes: one we'll close while frozen, one we leave alone.
      await splitActiveTerminalPane(orcaPage, 'vertical')
      await waitForPaneCount(orcaPage, 2, 30_000)

      const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
      // Why profiles/local-default: orca-data.json directly under userDataDir is
      // only a pre-migration/onboarding-seed location (see
      // src/main/orca-profiles/profile-storage-paths.ts) — the live store for a
      // running app lives at profiles/<profileId>/orca-data.json.
      const dataFile = path.join(userDataDir, 'profiles', 'local-default', 'orca-data.json')
      const readLeases = (): SshLease[] => {
        const raw = JSON.parse(readFileSync(dataFile, 'utf8'))
        return (raw.sshRemotePtyLeases ?? []).filter(
          (l: { targetId: string }) => l.targetId === remote.targetId
        )
      }
      const readLayout = (tabId: string): PersistedTerminalLayout | null =>
        readPersistedTerminalLayout(dataFile, tabId)
      // Only the pty list is scoped to `tabId`; `count` comes from the helper, which
      // resolves the active tab itself and falls back to the persisted layout when the
      // pane manager is empty under hidden-window mode.
      const readPaneState = async (
        tabId: string
      ): Promise<{ count: number; ptyIds: (string | undefined)[] }> => {
        const count = await countVisibleTerminalPanes(orcaPage)
        const ptyIds = await orcaPage.evaluate(
          (tabId) =>
            window.__paneManagers
              ?.get(tabId)
              ?.getPanes?.()
              .map((p) => p.container.dataset.ptyId) ?? [],
          tabId
        )
        return { count, ptyIds }
      }
      const readFullState = async (
        tabId: string
      ): Promise<{
        panes: { count: number; ptyIds: (string | undefined)[] }
        leases: SshLease[]
        layout: PersistedTerminalLayout | null
      }> => ({
        panes: await readPaneState(tabId),
        leases: readLeases(),
        layout: readLayout(tabId)
      })

      await orcaPage.evaluate(() => window.api.session.flush())
      // Resolve from the renderer, not from a lease row: the lease's tabId is one of the
      // things under test, so keying the whole spec on it could mask the bug.
      const tabId = await orcaPage.evaluate(() => {
        const state = window.__store?.getState()
        const worktreeId = state?.activeWorktreeId
        if (!state || !worktreeId) {
          return null
        }
        const tabs = state.tabsByWorktree[worktreeId] ?? []
        const active = state.activeTabType === 'terminal' ? state.activeTabId : null
        return active && tabs.some((t) => t.id === active) ? active : (tabs[0]?.id ?? null)
      })
      expect(tabId, 'a terminal tab must be resolvable before the repro starts').toBeTruthy()
      const terminalTabId = tabId as string
      const beforeClose = await readFullState(terminalTabId)
      // Without this the layout assertions below would pass on a partition that never
      // held this tab.
      expect(
        beforeClose.layout,
        'the tab must have a persisted layout in some workspace-session partition'
      ).not.toBeNull()

      const relayPid = findDockerSshRelayPid(target)
      if (relayPid === null) {
        throw new Error('No detached relay process found before freeze')
      }
      freezeDockerSshRelay(target, relayPid)

      // The pty.shutdown mux request has a live provider to send on but no responsive
      // peer, so it hangs until the mux timeout instead of taking the tombstone path.
      await closeActiveTerminalPane(orcaPage)
      // Why wait THEN flush THEN read immediately: the renderer's session patch is debounced,
      // so flushing first (or waiting after the flush) lets a late change miss the read.
      await orcaPage.waitForTimeout(1_500)
      await orcaPage.evaluate(() => window.api.session.flush()).catch(() => {})

      const afterClose = await readFullState(terminalTabId)

      // Log the setup evidence before any assertion can throw — a precondition
      // failure below must not erase it from the run log.
      console.log(
        `[ssh-reconnect-no-ghost-pane-graft] setup evidence ${JSON.stringify(
          { remoteTargetId: remote.targetId, tabId: terminalTabId, beforeClose, afterClose },
          null,
          2
        )}`
      )
      testInfo.annotations.push({
        type: 'ssh-reconnect-no-ghost-pane-graft-setup',
        description: JSON.stringify({
          remoteTargetId: remote.targetId,
          tabId: terminalTabId,
          beforeClose,
          afterClose
        })
      })

      // Precondition: exactly one pane left the screen, and it is the one whose lease
      // D4 must have retired. Keyed on the pane rather than on a durably-absent leaf:
      // the renderer's layout collapse is decoupled from the kill's outcome, so which
      // durable writes land across the close is not stable enough to assert on.
      const ptyIdsBefore = new Set(beforeClose.panes.ptyIds.filter(Boolean) as string[])
      const ptyIdsAfterClose = new Set(afterClose.panes.ptyIds.filter(Boolean) as string[])
      const closedPtyIds = [...ptyIdsBefore].filter((id) => !ptyIdsAfterClose.has(id))
      expect(
        closedPtyIds,
        'closing exactly one pane must remove exactly one pty from the screen'
      ).toHaveLength(1)
      const closedPtyId = closedPtyIds[0]

      // The D4 oracle. Before D4 this lease survived as 'attached'/'detached', which is
      // precisely the reattachKnownPtys eligibility filter that regrafts the ghost.
      const closedLeaseAfterClose = afterClose.leases.find(
        (l) => closedPtyId.endsWith(`@@${l.ptyId}`) || l.ptyId === closedPtyId
      )
      expect(
        closedLeaseAfterClose,
        'the closed pane must still have a lease row to inspect after close'
      ).toBeDefined()
      expect(
        closedLeaseAfterClose!.state,
        'D4: the close intent must be durable even though the shutdown RPC failed against the frozen relay'
      ).toMatch(/^(terminated|expired)$/)

      // Explicit disconnect while still frozen: detachAndPersist is local (mux/socket
      // teardown, no round-trip), so it completes despite the freeze, and its teardown
      // invalidates the still-pending close-time shutdown request.
      await disconnectDockerSshRelayTarget(orcaPage, remote.targetId)
      await orcaPage.evaluate(() => window.api.session.flush()).catch(() => {})
      const afterDisconnect = await readFullState(terminalTabId)

      unfreezeDockerSshRelay(target, relayPid)

      // Reconnect (no relay/process kill — just resume the SSH transport).
      await reconnectDisconnectedDockerSshRelayTarget(orcaPage, remote.targetId)
      await waitForActiveTerminalManager(orcaPage, 60_000)

      // Sample repeatedly to catch the converged state, not a mid-flight one, and to
      // catch a transient graft that later gets torn down.
      const timeline: {
        atMs: number
        state: Awaited<ReturnType<typeof readFullState>>
      }[] = []
      const start = Date.now()
      while (Date.now() - start < RECONNECT_SAMPLE_WINDOW_MS) {
        const state = await readFullState(terminalTabId)
        timeline.push({ atMs: Date.now() - start, state })
        await orcaPage.waitForTimeout(RECONNECT_SAMPLE_INTERVAL_MS)
      }

      // Same ordering rule as the post-close read: settle, flush, read immediately.
      await orcaPage.waitForTimeout(1_500)
      await orcaPage.evaluate(() => window.api.session.flush())
      const afterReconnect = await readFullState(terminalTabId)

      const evidence = {
        remoteTargetId: remote.targetId,
        closedPtyId,
        closedLeasePtyId: closedLeaseAfterClose!.ptyId,
        beforeClose,
        afterClose,
        afterDisconnect,
        timeline,
        afterReconnect
      }
      console.log(`[ssh-reconnect-no-ghost-pane-graft] ${JSON.stringify(evidence, null, 2)}`)
      testInfo.annotations.push({
        type: 'ssh-reconnect-no-ghost-pane-graft',
        description: JSON.stringify(evidence)
      })

      // D1b: reattach must not walk a retired lease back toward live.
      const retiredLeaseSamples = timeline.map(
        ({ state }) => state.leases.find((l) => l.ptyId === closedLeaseAfterClose!.ptyId)?.state
      )
      expect(
        retiredLeaseSamples.filter((state) => state === 'attached' || state === 'detached'),
        'a retired lease must never be revived by reattach'
      ).toEqual([])

      // I2: the closed pane must never be published back to the UI.
      const samplesWithPaneBack = timeline.filter(({ state }) =>
        state.panes.ptyIds.includes(closedPtyId)
      )
      expect(
        samplesWithPaneBack,
        'a pane the user explicitly closed must not reappear on reconnect'
      ).toEqual([])
      const samplesWithExtraPane = timeline.filter(
        ({ state }) => state.panes.count > afterClose.panes.count
      )
      expect(
        samplesWithExtraPane,
        'visible pane count must not exceed the post-close count at any sampled point after reconnect'
      ).toEqual([])
      // Without this guard a layout that vanished during the scenario would satisfy the
      // binding assertion below for the wrong reason.
      expect(
        afterReconnect.layout,
        'the tab must still have a persisted layout after reconnect settles'
      ).not.toBeNull()
      expect(
        Object.values(afterReconnect.layout!.ptyIdsByLeafId),
        'the closed pty must not be bound to any leaf after reconnect settles'
      ).not.toContain(closedPtyId)
      // Final-state guards: the timeline only covers its sample window, so a graft landing
      // after it must still fail here, on the converged durable state.
      expect(
        afterReconnect.panes.count,
        'visible pane count must settle at (or below) the post-close count'
      ).toBeLessThanOrEqual(afterClose.panes.count)
      const leafCountAfterClose = Object.keys(afterClose.layout?.ptyIdsByLeafId ?? {}).length
      expect(
        Object.keys(afterReconnect.layout!.ptyIdsByLeafId).length,
        'RC3 signature: reconnect must not graft leaves into the durable layout'
      ).toBeLessThanOrEqual(leafCountAfterClose)
      const rootTypeAfterClose = (afterClose.layout?.root as { type?: string } | null)?.type
      if (rootTypeAfterClose === 'leaf') {
        expect(
          (afterReconnect.layout!.root as { type?: string } | null)?.type,
          'RC3 signature: the durable root must not flip leaf -> split across a reconnect'
        ).toBe('leaf')
      }
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })
})
