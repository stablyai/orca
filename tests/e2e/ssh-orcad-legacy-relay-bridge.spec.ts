// Persist a pending relay stop across an app restart while preserving another desktop’s shell.
// COMPAT(legacy-relay-bridge): revisit 2027-01-15, with src/main/ssh/legacy-relay/.

import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'

import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { createRestartSession } from './helpers/orca-restart'
import { managedServer } from './helpers/orcad-convert-flow'
import { seedRelayEraProfile } from './helpers/orcad-upgrade-profile'
import { readPersistedProfileState } from './helpers/persisted-profile-state'

import { toSshExecutionHostId } from '../../src/shared/execution-host'
import { toAppSshPtyId } from '../../src/shared/ssh-pty-id'
import {
  cleanupDockerSshHostTarget,
  DOCKER_SSH_HOST_REMOTE_REPO_PATH,
  startDockerSshHostTarget,
  type DockerSshHostTarget
} from './helpers/docker-ssh-host-target'
import {
  echoThroughDockerRelay,
  installReleasedRelayOnDockerHost,
  listDockerRelayPtys,
  startDockerRelayWithShell
} from './helpers/legacy-relay-docker-host'

const TEMPLATE_SOURCE = process.env.ORCA_E2E_ORCAD_CONVERT_TEMPLATE
const BRIDGE_TIMEOUT_MS = 4 * 60_000

test.skip(
  process.env.ORCA_E2E_ORCAD_CONVERT_HOST !== 'docker' || !TEMPLATE_SOURCE,
  'Set ORCA_E2E_ORCAD_CONVERT_HOST=docker and ORCA_E2E_ORCAD_CONVERT_TEMPLATE'
)

let host: DockerSshHostTarget | null = null

test.afterEach(() => {
  cleanupDockerSshHostTarget(host)
  host = null
})

function bridgedPanes(page: Page): Promise<{ ptyId: string; state: string }[]> {
  return page.evaluate(async () => (await window.api.legacyRelayBridge?.listPanes()) ?? [])
}

function launchUpgraded(session: ReturnType<typeof createRestartSession>) {
  return session.launch({
    onStderr: (chunk) => {
      if (chunk.includes('[ssh]')) {
        process.stderr.write(chunk)
      }
    }
  })
}

test('a bridged tab closed while disconnected stops its shell even after a restart', async ({
  testRepoPath
}, testInfo: TestInfo) => {
  test.setTimeout(25 * 60_000)
  host = startDockerSshHostTarget(testInfo)
  const targetId = `ssh-bridge-close-${Date.now()}`
  const relay = await installReleasedRelayOnDockerHost(host, TEMPLATE_SOURCE!)
  const ours = await startDockerRelayWithShell(host, relay, targetId, 'before-upgrade')
  const theirs = await startDockerRelayWithShell(host, relay, 'another-desktop', 'theirs')
  const bridgedPtyId = toAppSshPtyId(targetId, ours.relayPtyId)
  const session = createRestartSession(testInfo, { ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE_SOURCE! })
  const ourLease = (): { state?: unknown; pendingKill?: unknown } | undefined => {
    const leases = readPersistedProfileState(session.userDataDir).sshRemotePtyLeases
    return (Array.isArray(leases) ? leases : []).find(
      (lease: { ptyId?: unknown }) => lease.ptyId === ours.relayPtyId
    )
  }
  let app: ElectronApplication | null = null
  try {
    const first = await session.launch()
    app = first.app
    await waitForSessionReady(first.page)
    await first.page.evaluate((repoPath) => window.api.repos.add({ path: repoPath }), testRepoPath)
    await session.close(app)
    app = null
    const seeded = seedRelayEraProfile(
      session.userDataDir,
      {
        label: `legacy relay bridge close E2E ${Date.now()}`,
        host: host.host,
        port: host.port,
        username: 'root',
        identityFile: host.identityFile,
        identitiesOnly: true,
        relayGracePeriodSeconds: 1
      },
      { repoPath: DOCKER_SSH_HOST_REMOTE_REPO_PATH, folderPath: '/tmp' },
      { targetId, relayPtyId: ours.relayPtyId }
    )

    const upgraded = await launchUpgraded(session)
    app = upgraded.app
    let page = upgraded.page
    await waitForSessionReady(page)
    await page.evaluate(
      ({ worktreeId, hostId, tabId }) => {
        const state = window.__store!.getState()
        state.setActiveWorktree(worktreeId, hostId)
        state.setActiveTab(tabId)
        state.setActiveTabType('terminal', worktreeId)
      },
      {
        worktreeId: seeded.worktreeId,
        hostId: toSshExecutionHostId(targetId),
        tabId: seeded.terminalTabId!
      }
    )
    await expect
      .poll(() => managedServer(page, targetId), { timeout: 8 * 60_000 })
      .toMatchObject({ kind: 'managed' })
    await expect
      .poll(() => bridgedPanes(page), { timeout: BRIDGE_TIMEOUT_MS })
      .toEqual([expect.objectContaining({ ptyId: bridgedPtyId, state: 'live' })])

    // Close while disconnected exercises both renderer PTY kill without a provider and the bridge transport close.
    await page.evaluate((id) => window.api.ssh.disconnect({ targetId: id }), targetId)
    await page.evaluate(async (ptyId) => {
      await window.api.pty.kill(ptyId)
      await window.api.legacyRelayBridge?.close({ ptyId })
    }, bridgedPtyId)
    // Loss of contact is never exit: the shell still runs, and its stop is owed.
    expect(await listDockerRelayPtys(host, relay, ours.sockPath)).toEqual([ours.relayPtyId])

    // Restart before reconnecting: only the persisted stop survives.
    await session.close(app)
    app = null
    expect(ourLease()?.state).not.toBe('terminated')
    expect(ourLease()?.pendingKill).toBeTruthy()

    const restarted = await launchUpgraded(session)
    app = restarted.app
    page = restarted.page
    await waitForSessionReady(page)
    await page.evaluate((id) => window.api.ssh.connect({ targetId: id }), targetId)
    // A failed listing is not absence: only the relay's own empty answer proves the shell stopped.
    await expect
      .poll(() => listDockerRelayPtys(host!, relay, ours.sockPath).catch(() => ['<unreachable>']), {
        timeout: BRIDGE_TIMEOUT_MS,
        intervals: [2_000]
      })
      .toEqual([])
    // Never offered back as a pane to reattach.
    expect(await bridgedPanes(page)).toEqual([])
    await session.close(app)
    app = null
    expect(ourLease()?.pendingKill).toBeUndefined()

    // Another desktop's relay keeps running its shell, untouched.
    expect(await echoThroughDockerRelay(host, relay, theirs, 'still-here')).toContain(
      'GOT:still-here'
    )
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
  }
})
