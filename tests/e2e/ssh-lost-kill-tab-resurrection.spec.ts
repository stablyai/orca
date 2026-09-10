import type { Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePanePtyId, waitForActiveTerminalManager } from './helpers/terminal'
import { createRemoteTerminalTab } from './helpers/docker-ssh-relay-terminal-tabs'
import {
  cleanupDockerSshRelayTarget,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import {
  readDockerSshRelayProcessSnapshot,
  terminateDockerSshRelay
} from './helpers/docker-ssh-relay-processes'
import {
  connectDockerSshRelayTarget,
  disconnectDockerSshRelayTarget,
  reconnectDisconnectedDockerSshRelayTarget
} from './helpers/docker-ssh-relay-connection'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const DROP_CYCLES = 3

test.use({ seedTestRepo: false })

async function readWorktreeTabIds(page: Page, worktreeId: string): Promise<string[]> {
  return page.evaluate(
    (id) => (window.__store?.getState().tabsByWorktree[id] ?? []).map((tab) => tab.id),
    worktreeId
  )
}

/** Poll until the tab set stops changing, so a resurrection that lands late still counts. */
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

/**
 * Kill the relay daemon so the next RPC rejects with a transport-class error.
 *
 * Why this and not a disconnect: `pty.kill` has to FAIL, not succeed against a dead session.
 * A transport rejection ("Multiplexer disposed" / CONNECTION_LOST) does not match
 * isPtyAlreadyGoneError, so the lease is never marked terminated and nothing retries it —
 * that unterminated lease is what the next reattach mistakes for a live PTY.
 */
function dropRelayTransport(target: DockerSshRelayTarget): void {
  const snapshot = readDockerSshRelayProcessSnapshot(target)
  if (!snapshot) {
    throw new Error('No Docker SSH relay process group to terminate')
  }
  terminateDockerSshRelay(target, snapshot)
}

async function dumpAuthority(page: Page, worktreeId: string, label: string): Promise<void> {
  const d = await page.evaluate(async (id) => {
    const persisted = await window.api.session.get()
    const state = window.__store?.getState()
    const repoId = Object.entries(state?.worktreesByRepo ?? {}).find(([, ws]) =>
      ws.some((w) => w.id === id)
    )?.[0]
    return {
      repoId: repoId?.slice(0, 8) ?? null,
      topologyRev: persisted.terminalTopologyRevisionByRepoId ?? null,
      tombstones: Object.keys(persisted.terminalSurfaceTombstonesByPaneKey ?? {}).length,
      storeTabs: (state?.tabsByWorktree[id] ?? []).length
    }
  }, worktreeId)
  console.log(`[auth ${label}] ${JSON.stringify(d)}`)
}

async function closeTerminalTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('Store unavailable')
    }
    state.closeTab(id)
  }, tabId)
}

/**
 * Run N cycles of: make a tab, disrupt the transport, close the tab, reconnect.
 *
 * `disrupt` is the only variable — the two callers differ solely in HOW the transport goes away,
 * so a difference in outcome is attributable to that and nothing else.
 */
async function runResurrectionCycles(
  page: Page,
  testInfo: TestInfo,
  disrupt: (target: DockerSshRelayTarget, targetId: string) => Promise<void> | void
): Promise<void> {
  let target: DockerSshRelayTarget | null = null
  try {
    target = startDockerSshRelayTarget(testInfo)
    await waitForSessionReady(page)
    const remote = await connectDockerSshRelayTarget(page, target)
    await expect
      .poll(() => waitForActiveWorktree(page), { timeout: 30_000 })
      .toBe(remote.worktreeId)
    await waitForActiveTerminalManager(page, 60_000)
    await waitForActivePanePtyId(page, 60_000)
    const baseline = await waitForSettledTabIds(page, remote.worktreeId)

    const perCycle: { closedTabId: string; afterIds: string[] }[] = []
    for (let cycle = 0; cycle < DROP_CYCLES; cycle += 1) {
      // Created while the transport is healthy — the disruption has to land between close and
      // reattach, not before the tab has a PTY to leave a lease behind.
      const beforeCreate = await waitForSettledTabIds(page, remote.worktreeId)
      await createRemoteTerminalTab(page, remote.worktreeId)
      const withExtra = await waitForSettledTabIds(page, remote.worktreeId)
      // Diffed against the PREVIOUS cycle's tabs, not the baseline: once a cycle resurrects a tab,
      // a baseline diff picks that survivor instead of the tab this cycle just made, and every
      // later cycle would close the same stale tab and measure nothing.
      const closedTabId = withExtra.find((tabId) => !beforeCreate.includes(tabId))
      if (!closedTabId) {
        throw new Error('The extra SSH tab was never added')
      }

      await dumpAuthority(page, remote.worktreeId, `cycle${cycle + 1}-before-close`)
      await disrupt(target, remote.targetId)
      await closeTerminalTab(page, closedTabId)
      await reconnectDisconnectedDockerSshRelayTarget(page, remote.targetId)
      await waitForActiveTerminalManager(page, 60_000)
      perCycle.push({
        closedTabId,
        afterIds: await waitForSettledTabIds(page, remote.worktreeId)
      })
      await dumpAuthority(page, remote.worktreeId, `cycle${cycle + 1}-after-reconnect`)
    }

    const growth = perCycle
      .map(
        (entry, index) =>
          `drop${index + 1}=${entry.afterIds.length}${entry.afterIds.includes(entry.closedTabId) ? ' (closed tab returned)' : ''}`
      )
      .join(' ')
    const summary = `baseline=${baseline.length} ${growth}`
    for (const [index, entry] of perCycle.entries()) {
      expect(
        entry.afterIds,
        `drop ${index + 1} resurrected the closed tab ${entry.closedTabId}: ${summary}`
      ).not.toContain(entry.closedTabId)
    }
    expect(
      perCycle.map((entry) => entry.afterIds.length),
      `tabs accumulated across dropped-transport closes: ${summary}`
    ).toEqual(perCycle.map(() => baseline.length))
  } finally {
    cleanupDockerSshRelayTarget(target)
  }
}

test.describe('SSH lost kill tab resurrection', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'Docker SSH restore uses POSIX SSH tooling.')

  // STA-3374. A tab closed while the transport is down leaves an unterminated remote lease: the
  // rejected `pty.kill` is a transport error, not an already-gone one, so nothing retires it. The
  // relay also restarts its pty counter at pty-1, so a later tab is handed the same id and
  // upsertSshRemotePtyLease — keyed on (targetId, ptyId) alone — collides with that stale lease
  // instead of minting a fresh one. The next reattach then re-mints the tab through
  // pty-binding-persistence.ts:145-160, and the resurrected tab never retires.
  test('does not resurrect tabs whose kill was lost to a killed relay daemon', async ({
    orcaPage
  }, testInfo) => {
    test.setTimeout(600_000)
    await runResurrectionCycles(orcaPage, testInfo, (target) => {
      dropRelayTransport(target)
    })
  })

  // The same close, reached the way a user reaches it: disconnect the host, close the tab, come
  // back. No daemon is killed. If this resurrects too, the bug needs no process death at all — a
  // laptop lid and a dropped link are enough.
  test('does not resurrect tabs closed while the host is disconnected', async ({
    orcaPage
  }, testInfo) => {
    test.setTimeout(600_000)
    await runResurrectionCycles(orcaPage, testInfo, async (_target, targetId) => {
      await disconnectDockerSshRelayTarget(orcaPage, targetId)
    })
  })
})
