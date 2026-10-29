// Convert a live detached 1.4.224 relay whose shell is named only on the tab/session map, preserving the same shell.
// Synthesized legacy pane-key aliases name no extra terminal and must not block conversion as waiting-to-reconnect.
// COMPAT(legacy-relay-bridge): revisit 2027-01-15, with src/main/ssh/legacy-relay/.
import { writeFileSync } from 'node:fs'
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { managedServer } from './helpers/orcad-convert-flow'
import { seedRelayEraProfile } from './helpers/orcad-upgrade-profile'
import { mutateStoppedProfileState } from './helpers/persisted-profile-state'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../../src/shared/execution-host'
import { toAppSshPtyId } from '../../src/shared/ssh-pty-id'
import { getOrcadSshDeployment } from '../../src/shared/runtime-environments'
import {
  cleanupDockerSshHostTarget,
  DOCKER_SSH_HOST_REMOTE_REPO_PATH,
  startDockerSshHostTarget,
  type DockerSshHostTarget
} from './helpers/docker-ssh-host-target'
import {
  installReleasedRelayOnDockerHost,
  listDockerRelayPtys,
  startDockerRelayWithShell
} from './helpers/legacy-relay-docker-host'
import { expectTerminalAccessibilityText } from './helpers/terminal-accessibility-tree'
import { focusActiveTerminalInput } from './helpers/terminal'

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recordAt(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key]
  if (!isRecord(value)) {
    throw new Error(`The seeded profile has no ${key}`)
  }
  return value
}

/** As an older build left a live relay tab at quit: the shell named on the tab, no pane binding. */
function nameRelayShellOnTabOnly(
  userDataDir: string,
  hostId: string,
  worktreeId: string,
  tabId: string,
  ptyId: string
): void {
  mutateStoppedProfileState(userDataDir, (state) => {
    const session = recordAt(recordAt(state, 'workspaceSessionsByHostId'), hostId)
    delete recordAt(recordAt(session, 'terminalLayoutsByTabId'), tabId).ptyIdsByLeafId
    session.remoteSessionIdsByTabId = { [tabId]: ptyId }
    session.activeWorktreeIdsOnShutdown = [worktreeId]
  })
}

function forwardSshLogs(chunk: string): void {
  if (chunk.includes('[ssh]') || chunk.includes('orcad')) {
    process.stderr.write(chunk)
  }
}

function bridgedPanes(page: Page): Promise<{ ptyId: string; state: string }[]> {
  return page.evaluate(async () => (await window.api.legacyRelayBridge?.listPanes()) ?? [])
}

/** The client mirrors the server's tab as `web-terminal-<tab::leaf>`; returns its id and key. */
async function mirroredTab(page: Page, tabId: string): Promise<{ id: string; key: string }> {
  let found = { id: '', key: '' }
  await expect
    .poll(
      async () => {
        found = await page.evaluate((wanted) => {
          for (const [key, tabs] of Object.entries(window.__store!.getState().tabsByWorktree)) {
            for (const tab of tabs ?? []) {
              const named = tab.id.startsWith('web-terminal-')
                ? decodeURIComponent(tab.id.slice('web-terminal-'.length))
                : ''
              if (named === wanted || named.startsWith(`${wanted}::`)) {
                return { id: tab.id, key }
              }
            }
          }
          return { id: '', key: '' }
        }, tabId)
        return found.id
      },
      { timeout: 120_000, message: 'the client never mirrored the relay-era tab' }
    )
    .not.toBe('')
  return found
}

test('an SSH host converts while a relay shell named only on its tab runs, and the tab keeps it', async ({
  testRepoPath
}, testInfo: TestInfo) => {
  test.setTimeout(20 * 60_000)
  host = startDockerSshHostTarget(testInfo)
  const targetId = `ssh-tab-only-${Date.now()}`
  const relay = await installReleasedRelayOnDockerHost(host, TEMPLATE_SOURCE!)
  const ours = await startDockerRelayWithShell(host, relay, targetId, 'before-move')
  const bridgedPtyId = toAppSshPtyId(targetId, ours.relayPtyId)
  const sshHostId = toSshExecutionHostId(targetId)
  const record: Record<string, unknown> = { relayPtyId: ours.relayPtyId, bridgedPtyId }

  const session = createRestartSession(testInfo, { ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE_SOURCE! })
  let app: ElectronApplication | null = null
  try {
    // The first launch only establishes the profile, with a local project to land on.
    const first = await session.launch()
    app = first.app
    await waitForSessionReady(first.page)
    await attachRepoAndOpenTerminal(first.page, testRepoPath)
    await first.page.waitForTimeout(2_000)
    await session.close(app)
    app = null
    const seeded = seedRelayEraProfile(
      session.userDataDir,
      {
        label: `tab-only relay E2E ${Date.now()}`,
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
    const terminalTabId = seeded.terminalTabId!
    nameRelayShellOnTabOnly(
      session.userDataDir,
      sshHostId,
      seeded.worktreeId,
      terminalTabId,
      bridgedPtyId
    )

    // Opening the old tab dials the host, which converts while its relay shell runs.
    const launched = await session.launch({ onStderr: forwardSshLogs })
    app = launched.app
    const page = launched.page
    await waitForSessionReady(page)
    await page.evaluate(
      ({ worktreeId, hostId, tabId }) => {
        const state = window.__store!.getState()
        state.setActiveView('terminal')
        state.setActiveWorktree(worktreeId, hostId)
        state.setActiveTab(tabId)
        state.setActiveTabType('terminal', worktreeId)
      },
      { worktreeId: seeded.worktreeId, hostId: sshHostId, tabId: terminalTabId }
    )
    await expect
      .poll(async () => (record.managedServer = await managedServer(page, targetId)), {
        timeout: 3 * 60_000
      })
      .toMatchObject({ kind: 'managed' })
    await expect
      .poll(() => bridgedPanes(page), { timeout: BRIDGE_TIMEOUT_MS })
      .toEqual([expect.objectContaining({ ptyId: bridgedPtyId, state: 'live' })])
    const environment = (await page.evaluate(() => window.api.runtimeEnvironments.list())).find(
      (entry) => getOrcadSshDeployment(entry)?.sshTargetId === targetId
    )
    if (!environment) {
      throw new Error('Converted host is missing from the environment catalog')
    }
    const runtimeHostId = toRuntimeExecutionHostId(environment.id)
    await page.evaluate(
      ({ worktreeId, hostId }) => {
        const state = window.__store!.getState()
        state.setGroupBy('none')
        window.__store!.setState({ visibleWorkspaceHostIds: ['local', hostId] })
        state.setActiveView('terminal')
        state.setActiveWorktree(worktreeId, hostId)
      },
      { worktreeId: seeded.worktreeId, hostId: runtimeHostId }
    )
    const mirrored = await mirroredTab(page, terminalTabId)
    await page.evaluate(
      ({ worktreeId, hostId, tabId }) => {
        const state = window.__store!.getState()
        state.setActiveWorktree(worktreeId, hostId)
        state.setActiveTab(tabId)
        state.setActiveTabType('terminal', worktreeId)
      },
      { worktreeId: mirrored.key, hostId: runtimeHostId, tabId: mirrored.id }
    )
    await expect
      .poll(() => page.evaluate((id) => window.__paneManagers?.has(id) ?? false, mirrored.id), {
        timeout: 120_000,
        message: 'the relay terminal tab never mounted after the move'
      })
      .toBe(true)
    // The same shell: its output from before the move is on screen, and it still answers.
    await expectTerminalAccessibilityText(page, mirrored.id, 'GOT:before-move', BRIDGE_TIMEOUT_MS)
    await focusActiveTerminalInput(page)
    await page.keyboard.type('after-move', { delay: 20 })
    await page.keyboard.press('Enter')
    await expectTerminalAccessibilityText(page, mirrored.id, 'GOT:after-move')
    await page.screenshot({ path: testInfo.outputPath('tab-only-shell-after-move.png') })
    // Never a second shell: the relay still runs exactly the one it started with.
    expect(await listDockerRelayPtys(host, relay, ours.sockPath)).toEqual([ours.relayPtyId])
    record.bridged = await bridgedPanes(page)
  } finally {
    writeFileSync(testInfo.outputPath('tab-only-shell.json'), JSON.stringify(record, null, 2))
    if (app) {
      await session.close(app)
    }
    await session.dispose()
  }
})
