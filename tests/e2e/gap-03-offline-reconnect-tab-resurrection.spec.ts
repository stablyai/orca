/**
 * GAP-03 (revive_labs#962 / stablyai/orca#22038): offline paired desktop clients retain stale
 * tabs in `orca-data.json` and re-inject them upon reconnect.
 *
 * `fetchWorkspaceSessionWithRuntimeHostOwners` (src/renderer/src/lib/workspace-session-host-hydration.ts)
 * runs exactly once per app lifetime, at renderer boot (`use-app-startup-hydration.ts`). It is
 * NOT re-run on a live WebSocket/SSH reconnect inside a running app — confirmed by grepping every
 * call site in this worktree. The bug therefore only manifests across an actual app relaunch: a
 * paired client whose SSH host closed some of its tabs while the client was gone (network drop or
 * the app itself not running), reopened later. `ssh-lost-kill-tab-resurrection.spec.ts` already
 * covers the sibling, single-process-lifetime bug (STA-3374, a lost `pty.kill` reattach); this
 * spec is deliberately a *two-launch* `createRestartSession` test — same shape as
 * `golden-quit-relaunch-session.spec.ts` / `persisted-session-production-upgrade.spec.ts` — so it
 * exercises the actual boot-time reconciliation path GAP-03 touches.
 *
 * Sequence, matching the six required GAP-03 repro steps:
 *   1. Pair a client (first Electron launch) to a Dockerized SSH host (`docker-ssh-relay-target`).
 *   2. Open N terminal tabs on the SSH-hosted worktree.
 *   3. "Go offline": quit the client app. Its on-disk `orca-data.json` (`local.tabsByWorktree` and
 *      the frozen `ssh:<targetId>` host-partition mirror in `workspaceSessionsByHostId`) persists
 *      untouched — this is the literal on-disk shape of "offline, app state intact".
 *   4. Close M of the N tabs "server-side" while offline: edit ONLY the local base row
 *      (`workspaceSession.tabsByWorktree`) down to N-M tabs, leaving the stale SSH host-partition
 *      mirror at N tabs. This is the exact fixture shape
 *      `workspace-session-host-offline-reconnect.test.ts` uses, and precisely what "closed by the
 *      server while this client was offline" produces on disk (the host partition write requires
 *      the live SSH transport, which the offline client no longer has — see the spec's Current
 *      State section for the full mechanism). Editing the file directly (rather than an in-app
 *      admin RPC call) is this repo's own established technique for this exact class of fixture —
 *      see `persisted-session-production-upgrade.spec.ts`'s `installProductionSessionFixture`.
 *   5. "Reconnect": relaunch the app against the same profile — this is what a user reopening an
 *      offline paired desktop client does, and the only trigger for the boot-time hydration path.
 *   6. Measure resurrection: do the M closed tabs reappear? Also measure the #12721 non-regression:
 *      does a tab drafted entirely offline (present only in `local`, absent from every host
 *      partition, because it was never synced) survive the same relaunch?
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../src/shared/orca-profiles'
import { toSshExecutionHostId } from '../../src/shared/execution-host'
import type { Tab, TabGroup, TabGroupLayoutNode } from '../../src/shared/tab-types'
import type { TerminalTab } from '../../src/shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../src/shared/workspace-session-state-types'
import { test, expect } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePanePtyId, waitForActiveTerminalManager } from './helpers/terminal'
import {
  createRemoteTerminalTab,
  readRemoteTerminalTabs
} from './helpers/docker-ssh-relay-terminal-tabs'
import {
  cleanupDockerSshRelayTarget,
  DOCKER_SSH_PROXY_JUMP_REMOTE_REPO_PATH,
  startDockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
// Why full closure, not partial: adoptStrandedHostPartitionSession's GAP-03 decline path
// (`reconciledWorktreeIds`) only distinguishes "the base names this worktree at all" from "it
// doesn't" -- see that module's own doc comment ("The one thing the base keeps unconditionally is
// a workspace it holds terminal tabs for... An EMPTY tab row is not such a copy"). A base row that
// still names ANY survivor tab makes `workspacesTheBaseOwns` treat the whole worktree as owned and
// excludes it from adoption entirely -- true before AND after the fix, so it proves nothing about
// the regression. The bug's own root-cause description is "every tab for a worktree closed
// server-side while a client was offline" -- not some. CLOSE_COUNT therefore defaults to, and is
// clamped to, TAB_COUNT.
const TAB_COUNT = Math.max(2, Number(process.env.ORCA_GAP03_TAB_COUNT ?? '2'))
const CLOSE_COUNT = Math.min(
  TAB_COUNT,
  Math.max(1, Number(process.env.ORCA_GAP03_CLOSE_COUNT ?? String(TAB_COUNT)))
)
const OFFLINE_DRAFT_TAB_ID = 'gap03-offline-draft-tab'

type SessionProfile = {
  workspaceSession: WorkspaceSessionState
  workspaceSessionsByHostId?: Record<string, WorkspaceSessionState>
}

function profilePath(userDataDir: string): string {
  return path.join(userDataDir, 'profiles', DEFAULT_LOCAL_ORCA_PROFILE_ID, 'orca-data.json')
}

function readProfile(userDataDir: string): SessionProfile {
  return JSON.parse(readFileSync(profilePath(userDataDir), 'utf8')) as SessionProfile
}

/** Emit one machine-readable KPI line, matching this project's before/after report convention. */
function logKpi(label: string, fields: Record<string, unknown>): void {
  console.log(`[gap-03] ${label}: ${JSON.stringify(fields)}`)
}

test.describe('GAP-03: offline client reconnect must not resurrect server-closed tabs (Docker cross-site)', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed GAP-03 tests.')
  test.skip(process.platform === 'win32', 'Docker SSH restore uses POSIX SSH tooling.')

  test('closed-while-offline tabs do not resurrect on client reopen; #12721 offline draft survives', async (// oxlint-disable-next-line no-empty-pattern -- this test owns both Electron launches.
  {}, testInfo) => {
    test.setTimeout(600_000)
    const session = createRestartSession(testInfo)
    const target = startDockerSshRelayTarget(testInfo)
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null

    try {
      // --- Step 1+2: pair to the Dockerized SSH host, open N tabs ---
      const first = await session.launch()
      firstApp = first.app
      await waitForSessionReady(first.page)
      const remote = await connectDockerSshRelayTarget(first.page, target)
      await expect
        .poll(() => waitForActiveWorktree(first.page), { timeout: 30_000 })
        .toBe(remote.worktreeId)
      await waitForActiveTerminalManager(first.page, 60_000)
      await waitForActivePanePtyId(first.page, 60_000)
      for (let i = 1; i < TAB_COUNT; i += 1) {
        await createRemoteTerminalTab(first.page, remote.worktreeId)
      }
      const openedTabs = await readRemoteTerminalTabs(first.page, remote.worktreeId)
      expect(openedTabs.length, 'setup must open exactly TAB_COUNT tabs').toBe(TAB_COUNT)

      // A second, real SSH-hosted worktree on the same target, connected with zero tabs. Its
      // host-partition mirror genuinely has nothing for it — the exact "host has nothing for it"
      // shape #12721 protects, reproduced with a real catalog entry instead of a synthetic key.
      const offlineDraftTarget = await connectDockerSshRelayTarget(first.page, target, {
        remotePath: DOCKER_SSH_PROXY_JUMP_REMOTE_REPO_PATH,
        seedInitialTab: false
      })
      logKpi('setup', {
        worktreeId: remote.worktreeId,
        tabCount: openedTabs.length,
        offlineDraftWorktreeId: offlineDraftTarget.worktreeId
      })

      // --- Step 3: "go offline" — quit the client; its on-disk state (including the frozen SSH
      // host-partition mirror) is left exactly as the live app last wrote it. ---
      await session.close(firstApp)
      firstApp = null

      const sshHostId = toSshExecutionHostId(remote.targetId)
      const preFaultProfile = readProfile(session.userDataDir)
      const hostMirrorTabs =
        preFaultProfile.workspaceSessionsByHostId?.[sshHostId]?.tabsByWorktree?.[remote.worktreeId]
      expect(
        hostMirrorTabs?.length,
        `the SSH host-partition mirror (${sshHostId}) must have cached every opened tab before the fault is injected`
      ).toBe(TAB_COUNT)
      logKpi('offline-snapshot', {
        sshHostId,
        localTabs: preFaultProfile.workspaceSession.tabsByWorktree[remote.worktreeId]?.length ?? 0,
        hostMirrorTabs: hostMirrorTabs?.length ?? 0
      })

      // --- Step 4: close M of the N tabs "server-side" while offline. `remote.worktreeId` is
      // SSH-hosted, so its worktree-keyed fields (tabsByWorktree, unifiedTabs, tabGroups, ...)
      // never land in the local base row in the first place — `buildHostSessionRouting` always
      // routes them to `ssh:<targetId>` at quit time, confirmed by offline-snapshot's
      // `localTabs: 0` above. "Closing" the base row is therefore deleting the key outright, never
      // writing an empty array: `adoptStrandedHostPartitionSession`'s GAP-03 decline path keys its
      // verdict on `Object.hasOwn(base.tabsByWorktree, workspaceId)`, and an explicit `[]`
      // satisfies `hasOwn` exactly as much as a populated row would — silently defeating the fix.
      // The stale SSH host-partition mirror is left untouched, matching what an offline client's
      // own on-disk cache looks like the moment it went unreachable. ---
      const closedIds = openedTabs.slice(0, CLOSE_COUNT).map((t) => t.id)
      const survivorIds = openedTabs.slice(CLOSE_COUNT).map((t) => t.id)
      const closedFaultProfile = readProfile(session.userDataDir)
      const survivorRow = (
        closedFaultProfile.workspaceSession.tabsByWorktree[remote.worktreeId] ?? []
      ).filter((tab) => survivorIds.includes(tab.id))
      if (survivorRow.length > 0) {
        closedFaultProfile.workspaceSession.tabsByWorktree[remote.worktreeId] = survivorRow
      } else {
        delete closedFaultProfile.workspaceSession.tabsByWorktree[remote.worktreeId]
      }

      // #12721 non-regression, injected in the same fault-injection pass: a tab drafted entirely
      // offline lives only in `local`, on a real, catalog-known worktree whose SSH host partition
      // has never heard of it at all (connected with zero tabs above) — the exact "host has
      // nothing for it" shape `workspace-session-host-offline-reconnect.test.ts`'s non-regression
      // case pins. Written in BOTH the legacy `tabsByWorktree` row and the modern unified-tab
      // format (`unifiedTabs`/`tabGroups`/`tabGroupLayouts`/`activeGroupIdByWorktree`/
      // `activeTabIdByWorktree`): the first real launch's own quit-time write already populated
      // `unifiedTabs`/`tabGroups` in `workspaceSession` (a running client always writes both
      // formats together), so `buildHydratedTabState` takes the unified branch
      // (`session.unifiedTabs && session.tabGroups`) on the second launch and enumerates worktrees
      // from `unifiedTabs` alone — never from `tabsByWorktree`. A row that exists only in the
      // legacy field is invisible to that enumeration, and even where `tabsByWorktree` IS swept
      // (`reconcileHydratedWorkspaceTabModels`), a legacy row with no live PTY and no unified twin
      // is exactly what `getOrphanTerminalIds` deletes as an orphan on the very same boot. This was
      // the #12721 anomaly: `offlineDraftSurvived: false` even on pre-fix code, because the tab
      // never reached a store the modern hydration path reads from at all.
      const offlineDraftWorktreeId = offlineDraftTarget.worktreeId
      const offlineDraftGroupId = `${OFFLINE_DRAFT_TAB_ID}-group`
      const offlineDraftTerminalTab: TerminalTab = {
        id: OFFLINE_DRAFT_TAB_ID,
        ptyId: null,
        worktreeId: offlineDraftWorktreeId,
        title: 'offline draft',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: Date.now()
      }
      const offlineDraftTab: Tab = {
        id: OFFLINE_DRAFT_TAB_ID,
        entityId: OFFLINE_DRAFT_TAB_ID,
        groupId: offlineDraftGroupId,
        worktreeId: offlineDraftWorktreeId,
        contentType: 'terminal',
        label: 'offline draft',
        customLabel: null,
        color: null,
        sortOrder: 0,
        createdAt: Date.now()
      }
      const offlineDraftGroup: TabGroup = {
        id: offlineDraftGroupId,
        worktreeId: offlineDraftWorktreeId,
        activeTabId: OFFLINE_DRAFT_TAB_ID,
        tabOrder: [OFFLINE_DRAFT_TAB_ID]
      }
      const offlineDraftLayout: TabGroupLayoutNode = { type: 'leaf', groupId: offlineDraftGroupId }
      closedFaultProfile.workspaceSession.tabsByWorktree[offlineDraftWorktreeId] = [
        offlineDraftTerminalTab
      ]
      closedFaultProfile.workspaceSession.unifiedTabs = {
        ...closedFaultProfile.workspaceSession.unifiedTabs,
        [offlineDraftWorktreeId]: [offlineDraftTab]
      }
      closedFaultProfile.workspaceSession.tabGroups = {
        ...closedFaultProfile.workspaceSession.tabGroups,
        [offlineDraftWorktreeId]: [offlineDraftGroup]
      }
      closedFaultProfile.workspaceSession.tabGroupLayouts = {
        ...closedFaultProfile.workspaceSession.tabGroupLayouts,
        [offlineDraftWorktreeId]: offlineDraftLayout
      }
      closedFaultProfile.workspaceSession.activeGroupIdByWorktree = {
        ...closedFaultProfile.workspaceSession.activeGroupIdByWorktree,
        [offlineDraftWorktreeId]: offlineDraftGroupId
      }
      closedFaultProfile.workspaceSession.activeTabIdByWorktree = {
        ...closedFaultProfile.workspaceSession.activeTabIdByWorktree,
        [offlineDraftWorktreeId]: OFFLINE_DRAFT_TAB_ID
      }
      // Prevent the second launch from auto-reconnecting either SSH target. GAP-03's own fix
      // (`fetchWorkspaceSessionWithRuntimeHostOwners`) is the boot-time PERSISTED-state merge; it
      // is not the only thing that can populate `tabsByWorktree` after a relaunch. If the client
      // still lists a target in `activeConnectionIdsAtShutdown`, `use-app-startup-hydration.ts`
      // auto-reconnects it, and a LIVE SSH reconnect pulls a fresh PTY snapshot straight off the
      // real host (`applyDirectSshRemoteWorkspaceSnapshot` / `mergeDirectSshRemoteWorkspaceSession`)
      // — a wholly separate code path GAP-03 never touches. This Docker fixture's "closed while
      // offline" tabs were only ever removed from the persisted JSON, never actually killed on the
      // container, so a live reconnect resyncs to the still-alive PTYs and resurrects them
      // regardless of the fix. Clearing this field keeps the second launch on the one path the
      // fix is verifying: boot-time hydration of persisted state, with nothing left to
      // second-guess it.
      delete closedFaultProfile.workspaceSession.activeConnectionIdsAtShutdown
      writeFileSync(
        profilePath(session.userDataDir),
        `${JSON.stringify(closedFaultProfile, null, 2)}\n`
      )
      logKpi('fault-injected', {
        closedIds,
        survivorIds,
        offlineDraftWorktreeId
      })

      // --- Step 5: "reconnect" — relaunch against the same profile. This is the only code path
      // that re-runs fetchWorkspaceSessionWithRuntimeHostOwners. ---
      const second = await session.launch()
      secondApp = second.app
      await waitForSessionReady(second.page)

      // --- Step 6: measure resurrection and the #12721 non-regression. ---
      const afterTabs = await readRemoteTerminalTabs(second.page, remote.worktreeId)
      const afterIds = afterTabs.map((t) => t.id)
      const resurrected = closedIds.filter((id) => afterIds.includes(id))
      const offlineDraftSurvived = await second.page.evaluate(
        (id) => (window.__store?.getState().tabsByWorktree[id] ?? []).map((tab) => tab.id),
        offlineDraftTarget.worktreeId
      )
      logKpi('post-relaunch', {
        expectedCount: survivorIds.length,
        actualCount: afterIds.length,
        resurrectedCount: resurrected.length,
        resurrectedIds: resurrected,
        offlineDraftSurvived: offlineDraftSurvived.includes(OFFLINE_DRAFT_TAB_ID)
      })

      expect(
        resurrected,
        `GAP-03: ${resurrected.length}/${closedIds.length} tabs closed while offline resurrected on reconnect`
      ).toEqual([])
      expect(
        afterIds.length,
        `tab count after reconnect must equal the survivor count, not the pre-close total`
      ).toBe(survivorIds.length)
      expect(
        offlineDraftSurvived,
        '#12721 non-regression: an offline-created, never-synced tab must survive reconnect'
      ).toContain(OFFLINE_DRAFT_TAB_ID)
    } finally {
      for (const app of [secondApp, firstApp]) {
        if (app) {
          await session.close(app).catch(() => undefined)
        }
      }
      await session.dispose()
      cleanupDockerSshRelayTarget(target)
    }
  })
})

test.describe('GAP-03 regression: an ordinary restart must not drop live tabs (Docker cross-site)', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed GAP-03 tests.')
  test.skip(process.platform === 'win32', 'Docker SSH restore uses POSIX SSH tooling.')

  test('tabs survive an ordinary quit + relaunch with nothing closed and the connection still active at shutdown', async (// oxlint-disable-next-line no-empty-pattern -- this test owns both Electron launches.
  {}, testInfo) => {
    test.setTimeout(300_000)
    const session = createRestartSession(testInfo)
    const target = startDockerSshRelayTarget(testInfo)
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null

    try {
      const first = await session.launch()
      firstApp = first.app
      await waitForSessionReady(first.page)
      const remote = await connectDockerSshRelayTarget(first.page, target)
      await expect
        .poll(() => waitForActiveWorktree(first.page), { timeout: 30_000 })
        .toBe(remote.worktreeId)
      await waitForActiveTerminalManager(first.page, 60_000)
      await waitForActivePanePtyId(first.page, 60_000)
      await createRemoteTerminalTab(first.page, remote.worktreeId)
      const openedTabs = await readRemoteTerminalTabs(first.page, remote.worktreeId)
      expect(openedTabs.length, 'setup must open exactly 2 tabs').toBe(2)

      // --- Ordinary quit: still connected, nothing closed, no fault injection whatsoever. This
      // is what the vast majority of real restarts look like, and is the exact case the
      // `reconciledWorktreeIds` decline path silently broke before this slice: `remote-repo-
      // registration.ts` stamps `executionHostId` on this repo (the modern, default shape), and
      // an SSH worktree's `tabsByWorktree` row never lands in the local base row at all -- so
      // "the base has nothing for this worktree" is true on EVERY boot, closed or not, and was
      // read as "the server's confirmed zero tabs" regardless of whether the target was ever
      // actually offline. ---
      await session.close(firstApp)
      firstApp = null

      const sshHostId = toSshExecutionHostId(remote.targetId)
      const profile = readProfile(session.userDataDir)
      expect(
        profile.workspaceSession.activeConnectionIdsAtShutdown ?? [],
        'the connection must still be recorded as active at shutdown -- this was never an offline gap'
      ).toContain(remote.targetId)
      const hostMirrorTabs =
        profile.workspaceSessionsByHostId?.[sshHostId]?.tabsByWorktree?.[remote.worktreeId]
      expect(hostMirrorTabs?.length, 'both tabs must be on disk before relaunch').toBe(2)
      logKpi('ordinary-restart-snapshot', {
        sshHostId,
        activeConnectionIdsAtShutdown: profile.workspaceSession.activeConnectionIdsAtShutdown,
        hostMirrorTabs: hostMirrorTabs?.length ?? 0
      })

      // --- Relaunch against the SAME, completely unmodified profile. ---
      const second = await session.launch()
      secondApp = second.app
      await waitForSessionReady(second.page)

      const afterTabs = await readRemoteTerminalTabs(second.page, remote.worktreeId)
      logKpi('ordinary-restart-post-relaunch', {
        expectedCount: openedTabs.length,
        actualCount: afterTabs.length,
        actualIds: afterTabs.map((t) => t.id)
      })
      expect(
        afterTabs.map((t) => t.id).sort(),
        'GAP-03 regression: an ordinary restart with nothing closed must not drop any live tab'
      ).toEqual(openedTabs.map((t) => t.id).sort())
    } finally {
      for (const app of [secondApp, firstApp]) {
        if (app) {
          await session.close(app).catch(() => undefined)
        }
      }
      await session.dispose()
      cleanupDockerSshRelayTarget(target)
    }
  })
})
