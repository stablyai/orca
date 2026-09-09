import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePanePtyId, waitForActiveTerminalManager } from './helpers/terminal'
import { createRemoteTerminalTab } from './helpers/docker-ssh-relay-terminal-tabs'
import {
  cleanupDockerSshRelayTarget,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import { createRestartSession } from './helpers/orca-restart'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const RESTART_CYCLES = 3
/** Consecutive agreeing samples that count as "the strip stopped changing". */
const SETTLED_SAMPLES = 3

test.use({ seedTestRepo: false })

type WorkspaceTabSnapshot = {
  /** Terminal tabs the store owns for the remote worktree. */
  worktreeTabIds: string[]
  /** Tabs the strip actually renders — what the user counts. */
  stripTabIds: string[]
  /** Why: a restart that re-adds the worktree under a new id would grow the window without growing the row above. */
  totalTabCount: number
  remoteWorktreeCount: number
}

async function readWorkspaceTabSnapshot(
  page: Page,
  worktreeId: string,
  repoId: string
): Promise<WorkspaceTabSnapshot> {
  const store = await page.evaluate(
    ({ worktreeId, repoId }) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('Store unavailable')
      }
      return {
        worktreeTabIds: (state.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id),
        totalTabCount: Object.values(state.tabsByWorktree).reduce(
          (total, tabs) => total + tabs.length,
          0
        ),
        remoteWorktreeCount: (state.worktreesByRepo[repoId] ?? []).length
      }
    },
    { worktreeId, repoId }
  )
  const stripTabIds = await page
    .locator('.terminal-tab-strip [data-tab-id]')
    .evaluateAll((elements) =>
      elements.map((element) => (element as HTMLElement).dataset.tabId ?? '')
    )
  return { ...store, stripTabIds }
}

/**
 * Sample the workspace until its tabs stop changing.
 *
 * Why: restore is not one event — the session rehydrates, then the relay reconnects, then worktree
 * activation runs. A tab spawned by the last of those is invisible to a snapshot taken after the
 * first, so sampling too early would let an accumulation bug pass.
 */
async function waitForSettledWorkspaceTabs(
  page: Page,
  worktreeId: string,
  repoId: string
): Promise<WorkspaceTabSnapshot> {
  let latest: WorkspaceTabSnapshot = {
    worktreeTabIds: [],
    stripTabIds: [],
    totalTabCount: 0,
    remoteWorktreeCount: 0
  }
  let previousKey = ''
  let agreements = 0
  await expect
    .poll(
      async () => {
        latest = await readWorkspaceTabSnapshot(page, worktreeId, repoId)
        const key = JSON.stringify(latest)
        agreements = key === previousKey ? agreements + 1 : 0
        previousKey = key
        return agreements
      },
      {
        timeout: 60_000,
        intervals: [1_000],
        message: 'the remote workspace tab set never stopped changing'
      }
    )
    .toBeGreaterThanOrEqual(SETTLED_SAMPLES)
  return latest
}

async function waitForRestoredRemoteWorktree(
  page: Page,
  targetId: string,
  worktreeId: string
): Promise<void> {
  await waitForSessionReady(page, 60_000)
  await expect.poll(() => waitForActiveWorktree(page), { timeout: 60_000 }).toBe(worktreeId)
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) => window.__store?.getState().sshConnectionStates.get(id)?.status,
          targetId
        ),
      { timeout: 90_000, message: 'renderer SSH state did not restore' }
    )
    .toBe('connected')
  await waitForActiveTerminalManager(page, 60_000)
  await waitForActivePanePtyId(page, 60_000)
}

/** Quit through the same beforeunload flush a real window close performs, then prove it landed. */
async function flushSessionBeforeQuit(
  page: Page,
  targetId: string,
  worktreeId: string,
  tabIds: string[]
): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')))
  await expect
    .poll(
      () =>
        page.evaluate(
          async ({ targetId, worktreeId, tabIds }) => {
            const persisted = await window.api.session.get()
            const persistedIds = new Set(
              (persisted.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
            )
            return (
              persisted.activeConnectionIdsAtShutdown?.includes(targetId) === true &&
              tabIds.every((tabId) => persistedIds.has(tabId))
            )
          },
          { targetId, worktreeId, tabIds }
        ),
      { timeout: 15_000, message: 'SSH tabs and active target were not persisted before quit' }
    )
    .toBe(true)
}

function describeGrowth(baseline: WorkspaceTabSnapshot, cycles: WorkspaceTabSnapshot[]): string {
  const baselineTabIds = new Set(baseline.worktreeTabIds)
  const perCycle = cycles.map((cycle, index) => {
    const added = cycle.worktreeTabIds.filter((tabId) => !baselineTabIds.has(tabId))
    const suffix = added.length > 0 ? ` (+${added.length}: ${added.join(', ')})` : ''
    return `restart${index + 1}=${cycle.worktreeTabIds.length}${suffix}/strip${cycle.stripTabIds.length}/all${cycle.totalTabCount}/worktrees${cycle.remoteWorktreeCount}`
  })
  return `baseline=${baseline.worktreeTabIds.length}/strip${baseline.stripTabIds.length}/all${baseline.totalTabCount}/worktrees${baseline.remoteWorktreeCount} ${perCycle.join(' ')}`
}

async function runRestartCycles(testInfo: TestInfo, initialTabCount: number): Promise<void> {
  const restart = createRestartSession(testInfo)
  let target: DockerSshRelayTarget | null = null
  let app: ElectronApplication | null = null
  try {
    target = startDockerSshRelayTarget(testInfo)
    const firstLaunch = await restart.launch()
    app = firstLaunch.app
    let page = firstLaunch.page
    await waitForSessionReady(page)
    const remote = await connectDockerSshRelayTarget(page, target)
    await expect
      .poll(() => waitForActiveWorktree(page), { timeout: 30_000 })
      .toBe(remote.worktreeId)
    await waitForActiveTerminalManager(page, 60_000)
    await waitForActivePanePtyId(page, 60_000)

    while (
      (await readWorkspaceTabSnapshot(page, remote.worktreeId, remote.repoId)).worktreeTabIds
        .length < initialTabCount
    ) {
      await createRemoteTerminalTab(page, remote.worktreeId)
    }
    const baseline = await waitForSettledWorkspaceTabs(page, remote.worktreeId, remote.repoId)
    expect(baseline.worktreeTabIds).toHaveLength(initialTabCount)
    expect(baseline.stripTabIds.slice().sort()).toEqual(baseline.worktreeTabIds.slice().sort())

    // Why: every cycle runs before anything is asserted, so a failure reports whether the strip
    // grows by one per restart or duplicates wholesale — those have different causes.
    const cycles: WorkspaceTabSnapshot[] = []
    for (let cycle = 0; cycle < RESTART_CYCLES; cycle += 1) {
      await flushSessionBeforeQuit(
        page,
        remote.targetId,
        remote.worktreeId,
        baseline.worktreeTabIds
      )
      await restart.close(app)
      app = null
      const relaunch = await restart.launch()
      app = relaunch.app
      page = relaunch.page
      await waitForRestoredRemoteWorktree(page, remote.targetId, remote.worktreeId)
      cycles.push(await waitForSettledWorkspaceTabs(page, remote.worktreeId, remote.repoId))
    }

    const growth = describeGrowth(baseline, cycles)
    expect(
      cycles.map((cycle) => cycle.stripTabIds.length),
      `tab strip grew across restarts: ${growth}`
    ).toEqual(Array.from({ length: RESTART_CYCLES }, () => initialTabCount))
    expect(
      cycles.map((cycle) => cycle.totalTabCount),
      `total tab count grew across restarts: ${growth}`
    ).toEqual(cycles.map(() => baseline.totalTabCount))
    expect(
      cycles.map((cycle) => cycle.remoteWorktreeCount),
      `the remote repo gained worktree rows across restarts: ${growth}`
    ).toEqual(cycles.map(() => baseline.remoteWorktreeCount))
    const expectedTabIds = baseline.worktreeTabIds.slice().sort()
    for (const [index, cycle] of cycles.entries()) {
      expect(cycle.worktreeTabIds.slice().sort(), `restart ${index + 1}: ${growth}`).toEqual(
        expectedTabIds
      )
      expect(
        cycle.stripTabIds.slice().sort(),
        `restart ${index + 1} rendered different tabs: ${growth}`
      ).toEqual(expectedTabIds)
    }
  } finally {
    if (app) {
      await restart.close(app)
    }
    await restart.dispose()
    cleanupDockerSshRelayTarget(target)
  }
}

test.describe('SSH restart tab accumulation', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'Docker SSH restore uses POSIX SSH tooling.')

  // Why three restarts and not one: a single restart only proves one restore was clean. Users reach
  // this by returning to the same SSH workspace day after day, so the invariant worth pinning is
  // that N restarts add nothing — one spurious tab per launch is invisible to a one-shot test.
  test('keeps a single restored SSH tab across repeated quit and relaunch cycles', async (// oxlint-disable-next-line no-empty-pattern -- This restart test owns every Electron launch.
  {}, testInfo) => {
    test.setTimeout(600_000)
    await runRestartCycles(testInfo, 1)
  })

  // Why a second size: separates "one spurious default tab per restart" from "the set duplicates".
  test('keeps every restored SSH tab across repeated quit and relaunch cycles', async (// oxlint-disable-next-line no-empty-pattern -- This restart test owns every Electron launch.
  {}, testInfo) => {
    test.setTimeout(600_000)
    await runRestartCycles(testInfo, 3)
  })
})
