import { spawnSync } from 'node:child_process'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePanePtyId, waitForActiveTerminalManager } from './helpers/terminal'
import { createRemoteTerminalTab } from './helpers/docker-ssh-relay-terminal-tabs'
import {
  cleanupDockerSshRelayTarget,
  execDockerSshRelayTargetControlCommand,
  shellQuote,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import { createRestartSession } from './helpers/orca-restart'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const BASELINE_TAB_COUNT = 3
/** Where the relay persists a target's workspace snapshot inside the fixture container. */
const REMOTE_SNAPSHOT_DIR = '/root/.orca/sessions'

test.use({ seedTestRepo: false })

async function readWorktreeTabIds(page: Page, worktreeId: string): Promise<string[]> {
  return page.evaluate(
    (id) => (window.__store?.getState().tabsByWorktree[id] ?? []).map((tab) => tab.id),
    worktreeId
  )
}

async function isTargetHydrated(page: Page, targetId: string): Promise<boolean> {
  return page.evaluate(
    (id) => window.__store?.getState().remoteWorkspaceHydratedTargetIds.has(id) === true,
    targetId
  )
}

async function readTargetSyncPhase(page: Page, targetId: string): Promise<string | undefined> {
  return page.evaluate(
    (id) => window.__store?.getState().remoteWorkspaceSyncStatusByTargetId[id]?.phase,
    targetId
  )
}

/** Poll until the worktree's tabs stop changing, so a late seed cannot slip past the sample. */
async function waitForSettledTabIds(page: Page, worktreeId: string): Promise<string[]> {
  let latest: string[] = []
  let previousKey = ''
  let agreements = 0
  await expect
    .poll(
      async () => {
        latest = await readWorktreeTabIds(page, worktreeId)
        const key = latest.join()
        agreements = key === previousKey ? agreements + 1 : 0
        previousKey = key
        return agreements
      },
      { timeout: 60_000, intervals: [1_000], message: 'the tab set never stopped changing' }
    )
    .toBeGreaterThanOrEqual(3)
  return latest
}

function findRemoteSnapshotPath(target: DockerSshRelayTarget): string | null {
  const listing = execDockerSshRelayTargetControlCommand(
    target,
    `ls -1 ${REMOTE_SNAPSHOT_DIR}/*.json 2>/dev/null || true`
  ).trim()
  return listing.split('\n').find((line) => line.endsWith('.json')) ?? null
}

async function waitForUploadedRemoteSnapshot(target: DockerSshRelayTarget): Promise<string> {
  let snapshotPath: string | null = null
  await expect
    .poll(
      () => {
        snapshotPath = findRemoteSnapshotPath(target)
        return snapshotPath
      },
      { timeout: 60_000, message: 'the relay never persisted a workspace snapshot' }
    )
    .not.toBeNull()
  return snapshotPath!
}

/**
 * Replace the relay's snapshot file with a FIFO so `workspace.get` blocks on open.
 *
 * Why a FIFO and not a stall injected into the app: the relay reads this path with `readFileSync`,
 * so an unopened FIFO stalls the real RPC exactly where a stalled link would, and writing to it
 * later releases that same call with the real bytes. A test-only hook would drift from the
 * production path silently, which is how this class of bug survives in the first place.
 */
function blockRemoteWorkspaceGet(target: DockerSshRelayTarget, snapshotPath: string): string {
  const saved = execDockerSshRelayTargetControlCommand(target, `cat ${snapshotPath}`)
  execDockerSshRelayTargetControlCommand(
    target,
    `rm -f ${snapshotPath} && mkfifo -m 600 ${snapshotPath}`
  )
  return saved
}

function unblockRemoteWorkspaceGet(
  target: DockerSshRelayTarget,
  snapshotPath: string,
  saved: string
): void {
  // Detached: a FIFO write blocks until the reader drains it, which must not stall the test.
  spawnSync('docker', [
    'exec',
    '-d',
    target.containerName,
    'bash',
    '--noprofile',
    '--norc',
    '-c',
    `printf '%s' ${shellQuote(saved)} > ${snapshotPath} && rm -f ${snapshotPath} && printf '%s' ${shellQuote(saved)} > ${snapshotPath}`
  ])
}

async function connectAndSeedTabs(
  page: Page,
  target: DockerSshRelayTarget
): Promise<{ targetId: string; repoId: string; worktreeId: string; tabIds: string[] }> {
  const remote = await connectDockerSshRelayTarget(page, target)
  await expect.poll(() => waitForActiveWorktree(page), { timeout: 30_000 }).toBe(remote.worktreeId)
  await waitForActiveTerminalManager(page, 60_000)
  await waitForActivePanePtyId(page, 60_000)
  while ((await readWorktreeTabIds(page, remote.worktreeId)).length < BASELINE_TAB_COUNT) {
    await createRemoteTerminalTab(page, remote.worktreeId)
  }
  return { ...remote, tabIds: await waitForSettledTabIds(page, remote.worktreeId) }
}

async function flushSessionBeforeQuit(page: Page, targetId: string): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')))
  await expect
    .poll(
      () =>
        page.evaluate(async (id) => {
          const persisted = await window.api.session.get()
          return persisted.activeConnectionIdsAtShutdown?.includes(id) === true
        }, targetId),
      { timeout: 15_000, message: 'the active SSH target was not persisted before quit' }
    )
    .toBe(true)
}

test.describe('SSH cold hydration gap tab seeding', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'Docker SSH restore uses POSIX SSH tooling.')

  // Why this shape: worktree activation seeds an initial terminal from a predicate that knows
  // nothing about host authority, so a relaunch that activates the worktree before the host
  // snapshot lands can add a tab the host never had. Stalling `workspace.get` holds that window
  // open for as long as the assertions need instead of racing a local relay.
  test('adds no tab when the host workspace snapshot stalls across a relaunch', async (// oxlint-disable-next-line no-empty-pattern -- This restart test owns every Electron launch.
  {}, testInfo) => {
    test.setTimeout(600_000)
    const restart = createRestartSession(testInfo)
    let target: DockerSshRelayTarget | null = null
    let app: ElectronApplication | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      const firstLaunch = await restart.launch()
      app = firstLaunch.app
      await waitForSessionReady(firstLaunch.page)
      const remote = await connectAndSeedTabs(firstLaunch.page, target)
      expect(remote.tabIds).toHaveLength(BASELINE_TAB_COUNT)
      const snapshotPath = await waitForUploadedRemoteSnapshot(target)
      await flushSessionBeforeQuit(firstLaunch.page, remote.targetId)
      await restart.close(app)
      app = null

      const saved = blockRemoteWorkspaceGet(target, snapshotPath)
      const relaunch = await restart.launch()
      app = relaunch.app
      const page = relaunch.page
      // No PTY wait here: the stalled read holds the relay's only thread, so nothing else it serves
      // can complete either. That is the point — this is the window a resumed laptop sits in.
      await waitForSessionReady(page, 60_000)
      await expect
        .poll(() => waitForActiveWorktree(page), { timeout: 60_000 })
        .toBe(remote.worktreeId)
      // Proves the intended branch was taken rather than the symptom merely being absent: the
      // target must still be unhydrated while the snapshot has not arrived.
      expect(
        await isTargetHydrated(page, remote.targetId),
        'the target hydrated despite a stalled workspace.get, so this never entered the gap'
      ).toBe(false)
      const duringStall = await waitForSettledTabIds(page, remote.worktreeId)

      unblockRemoteWorkspaceGet(target, snapshotPath, saved)
      await expect
        .poll(() => isTargetHydrated(page, remote.targetId), {
          timeout: 120_000,
          message: 'the target never hydrated after the snapshot was released'
        })
        .toBe(true)
      const afterHydration = await waitForSettledTabIds(page, remote.worktreeId)

      const growth = `baseline=${remote.tabIds.length} duringStall=${duringStall.length} afterHydration=${afterHydration.length}`
      expect(duringStall.slice().sort(), `tabs changed inside the stall window: ${growth}`).toEqual(
        remote.tabIds.slice().sort()
      )
      expect(
        afterHydration.slice().sort(),
        `tabs changed once the stalled snapshot landed: ${growth}`
      ).toEqual(remote.tabIds.slice().sort())
    } finally {
      if (app) {
        await restart.close(app)
      }
      await restart.dispose()
      cleanupDockerSshRelayTarget(target)
    }
  })

  // Why a second profile and not another restart: the seeding predicate is
  // `renderableTabCount === 0 && !Object.hasOwn(tabsByWorktree, worktreeId)`, and a restart always
  // restores that key from local state, so the second term is never false. A client that has never
  // held this workspace — a re-added host, a cleared profile, a second machine — is the ordinary
  // way a user reaches a host that already owns tabs with no local row for them.
  test('does not mark hydration or seed a tab when it could not place the host tabs', async (// oxlint-disable-next-line no-empty-pattern -- This restart test owns every Electron launch.
  {}, testInfo) => {
    test.setTimeout(600_000)
    const seeding = createRestartSession(testInfo)
    const fresh = createRestartSession(testInfo)
    let target: DockerSshRelayTarget | null = null
    let seedingApp: ElectronApplication | null = null
    let freshApp: ElectronApplication | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      const firstLaunch = await seeding.launch()
      seedingApp = firstLaunch.app
      await waitForSessionReady(firstLaunch.page)
      const remote = await connectAndSeedTabs(firstLaunch.page, target)
      expect(remote.tabIds).toHaveLength(BASELINE_TAB_COUNT)
      await waitForUploadedRemoteSnapshot(target)
      await flushSessionBeforeQuit(firstLaunch.page, remote.targetId)
      await seeding.close(seedingApp)
      seedingApp = null

      const freshLaunch = await fresh.launch()
      freshApp = freshLaunch.app
      await waitForSessionReady(freshLaunch.page, 60_000)
      // seedInitialTab: false so every tab counted below is one the product produced — the helper's
      // own convenience tab would otherwise be indistinguishable from a spurious seed.
      const rejoined = await connectDockerSshRelayTarget(freshLaunch.page, target, {
        seedInitialTab: false
      })
      await expect
        .poll(() => waitForActiveWorktree(freshLaunch.page), { timeout: 60_000 })
        .toBe(rejoined.worktreeId)
      // The sync point the old `hydrated === true` poll used to serve. `conflict` is what the apply
      // publishes once it finds rows it cannot place, so it marks the same instant without pinning
      // the defect: hydration used to be marked here regardless of what adoption wrote.
      await expect
        .poll(() => readTargetSyncPhase(freshLaunch.page, rejoined.targetId), {
          timeout: 120_000,
          message: 'the fresh client never reported the unplaced snapshot as a conflict'
        })
        .toBe('conflict')
      const rejoinedTabIds = await waitForSettledTabIds(freshLaunch.page, rejoined.worktreeId)
      const hydrated = await isTargetHydrated(freshLaunch.page, rejoined.targetId)
      // Re-read after settling: a conflict verdict that a later apply flips back would re-authorise
      // seeding, so the phase has to still hold once the tab set has stopped moving.
      const settledPhase = await readTargetSyncPhase(freshLaunch.page, rejoined.targetId)
      console.log(
        `[unplaced-host-tabs] hydrated=${hydrated} phase=${settledPhase} tabs=${rejoinedTabIds.length}`
      )

      // STA-3593. The host listed three tabs on paths this client cannot place. Adoption still
      // writes nothing (the fixme below), but the client must no longer claim the host's workspace
      // on the strength of that empty result:
      //   1. hydration is not marked — and is revoked if an earlier clean sync had set it — so
      //      use-app-session-persistence.ts cannot upload a `replace-session` patch built from the
      //      incomplete picture and delete the very tabs it failed to place;
      //   2. the phase is `conflict`, which workspace-terminal-host-authority.ts deliberately keeps
      //      out of its `offline`/`error` floor, so authority stays `unverifiable` rather than
      //      resolving to `none`;
      //   3. therefore Terminal.tsx does not seed. The old behaviour was exactly one tab conjured
      //      from nothing, replacing the host's three.
      expect(hydrated, 'an unplaced snapshot must not leave the target marked hydrated').toBe(false)
      expect(
        settledPhase,
        'the unplaced verdict has to survive settling, or authority is re-authorised to seed'
      ).toBe('conflict')
      expect(
        rejoinedTabIds.length,
        `authority stays unverifiable, so no tab may be seeded: got ${rejoinedTabIds.length}`
      ).toBe(0)
    } finally {
      if (freshApp) {
        await fresh.close(freshApp)
      }
      if (seedingApp) {
        await seeding.close(seedingApp)
      }
      await fresh.dispose()
      await seeding.dispose()
      cleanupDockerSshRelayTarget(target)
    }
  })

  // The remaining half of the gap. The hydration half above is fixed: the client no longer marks
  // hydration, no longer overwrites the host, and no longer seeds a phantom tab. What it still does
  // not do is ADOPT — a client with no local row is exactly the case the host snapshot exists to
  // serve, so it should end up holding the host's tabs rather than an empty workspace. Declining to
  // seed is a safe wait, not the destination. Kept as a fixme so the gap stays visible without
  // putting a knowingly-red spec in the lane. STA-3593 (snapshot tabs dropped when the worktree
  // catalog resolves their paths late).
  test.fixme('a client with no local row adopts the tabs the host already owns', async (// oxlint-disable-next-line no-empty-pattern -- Placeholder for the fixed behaviour.
  {}) => {})
})
