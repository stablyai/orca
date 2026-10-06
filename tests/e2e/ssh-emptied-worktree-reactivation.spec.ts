import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePanePtyId, waitForActiveTerminalManager } from './helpers/terminal'
import {
  cleanupDockerSshRelayTarget,
  execDockerSshRelayTargetControlCommand,
  shellQuote,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import {
  connectDockerSshRelayTarget,
  disconnectDockerSshRelayTarget,
  reconnectDisconnectedDockerSshRelayTarget
} from './helpers/docker-ssh-relay-connection'
import {
  readTargetSyncPhase,
  waitForUploadedRemoteSnapshot
} from './helpers/docker-ssh-relay-workspace-snapshot'
import { worktreeRowSurface } from './worktree-row-locators'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const FOREIGN_WORKTREE_PATH = '/tmp/another-machines-worktree'

test.use({ seedTestRepo: false })

type HostSnapshot = {
  revision: number
  updatedAt: number
  session: { tabsByWorktreePath: Record<string, { id: string }[]> }
}

async function readTabCount(page: Page, worktreeId: string): Promise<number> {
  return page.evaluate(
    (id) => (window.__store?.getState().tabsByWorktree[id] ?? []).length,
    worktreeId
  )
}

/** Close the worktree's only tab the way a user does, then reopen the worktree from the sidebar. */
async function closeLastTabAndClickWorktree(page: Page, worktreeId: string): Promise<void> {
  const tabId = await page.evaluate(
    (id) => window.__store?.getState().tabsByWorktree[id]?.[0]?.id ?? null,
    worktreeId
  )
  expect(tabId, 'the worktree has no tab to close').not.toBeNull()
  const tab = page.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`).first()
  await tab.hover()
  await tab.locator('button[aria-label^="Close tab"]').first().click()
  await expect.poll(() => readTabCount(page, worktreeId), { timeout: 15_000 }).toBe(0)
  await worktreeRowSurface(page, worktreeId).click()
}

/**
 * Give the host one tab on a folder this client has no worktree for — what a second machine using
 * the same host leaves behind. Edits the relay's own snapshot file, so the next `workspace.get`
 * serves it through the real path.
 */
function addForeignTabToHostSnapshot(target: DockerSshRelayTarget, snapshotPath: string): void {
  const snapshot: HostSnapshot = JSON.parse(
    execDockerSshRelayTargetControlCommand(target, `cat ${shellQuote(snapshotPath)}`)
  )
  const ownTab = Object.values(snapshot.session.tabsByWorktreePath).flat()[0]
  expect(ownTab, 'the host snapshot never recorded this client tab').toBeTruthy()
  snapshot.session.tabsByWorktreePath[FOREIGN_WORKTREE_PATH] = [
    { ...ownTab, id: 'foreign-tab-from-another-machine' }
  ]
  snapshot.revision += 1
  snapshot.updatedAt = Date.now()
  execDockerSshRelayTargetControlCommand(
    target,
    `printf '%s' ${shellQuote(JSON.stringify(snapshot))} > ${shellQuote(snapshotPath)}`
  )
}

test.describe('SSH emptied worktree reactivation', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'Docker SSH uses POSIX SSH tooling.')

  // #22015: one host tab this client cannot place put the whole target in `conflict`, and every
  // worktree on it then refused a terminal — including ones whose own tabs had been applied.
  test('clicking an emptied worktree opens a terminal while the host holds a tab this client cannot place', async ({
    orcaPage
  }, testInfo) => {
    test.setTimeout(600_000)
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      await waitForSessionReady(orcaPage)
      const remote = await connectDockerSshRelayTarget(orcaPage, target)
      await expect
        .poll(() => waitForActiveWorktree(orcaPage), { timeout: 30_000 })
        .toBe(remote.worktreeId)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      await waitForActivePanePtyId(orcaPage, 60_000)
      const snapshotPath = await waitForUploadedRemoteSnapshot(target)

      await disconnectDockerSshRelayTarget(orcaPage, remote.targetId)
      addForeignTabToHostSnapshot(target, snapshotPath)
      await reconnectDisconnectedDockerSshRelayTarget(orcaPage, remote.targetId)
      // Proves the intended branch was taken: the placement wait has ended in a pull conflict.
      await expect
        .poll(() => readTargetSyncPhase(orcaPage, remote.targetId), {
          timeout: 60_000,
          message: 'the unplaceable host tab never put the target in conflict'
        })
        .toBe('conflict')

      await closeLastTabAndClickWorktree(orcaPage, remote.worktreeId)

      await expect
        .poll(() => readTabCount(orcaPage, remote.worktreeId), {
          timeout: 20_000,
          message: 'no terminal came back after clicking the emptied worktree'
        })
        .toBe(1)
      await waitForActivePanePtyId(orcaPage, 60_000)
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })
})
