// Upgrade a live detached 1.4.224 relay to managed orcad while preserving its original tab/shell across SSH loss and explicit disconnect.
// Retire the pane/lease only on exit; never touch another desktop’s relay. If its project already moved, keep connected without moving until the shell exits.
// COMPAT(legacy-relay-bridge): revisit 2027-01-15, with src/main/ssh/legacy-relay/.
import { mkdirSync, truncateSync, writeFileSync } from 'node:fs'
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { z } from 'zod'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { createRestartSession } from './helpers/orca-restart'
import { managedServer, reconnect, serverCall } from './helpers/orcad-convert-flow'
import { seedRelayEraProfile } from './helpers/orcad-upgrade-profile'
import {
  mutateStoppedProfileState,
  readPersistedProfileState
} from './helpers/persisted-profile-state'
import { workspaceSessionStateSchema } from '../../src/shared/workspace-session-schema'
import {
  getProfileTerminalScrollbackSnapshotRoot,
  getTerminalScrollbackSnapshotPath,
  makeTerminalScrollbackSnapshotRef
} from '../../src/main/terminal-scrollback-snapshots'
import { TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT } from '../../src/shared/terminal-scrollback-limits'
import { getOrcaProfileDataFile } from '../../src/shared/profile-state-storage-paths'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../src/shared/orca-profiles'
import { getOrcadSshDeployment } from '../../src/shared/runtime-environments'
import { toSshExecutionHostId } from '../../src/shared/execution-host'
import { toAppSshPtyId } from '../../src/shared/ssh-pty-id'
import {
  cleanupDockerSshHostTarget,
  DOCKER_SSH_HOST_REMOTE_REPO_PATH,
  execDockerSshHostTargetControlCommand,
  startDockerSshHostTarget,
  type DockerSshHostTarget
} from './helpers/docker-ssh-host-target'
import {
  echoThroughDockerRelay,
  installReleasedRelayOnDockerHost,
  listDockerRelayPtys,
  startDockerRelayWithShell
} from './helpers/legacy-relay-docker-host'
import {
  callEnvironment,
  createPairedHostTerminal,
  openPairedClientTab
} from './helpers/paired-host-terminal'
import { expectTerminalAccessibilityText } from './helpers/terminal-accessibility-tree'
import { focusActiveTerminalInput } from './helpers/terminal'
import { findOrcadMigrationSourceCutoverForTarget } from '../../src/main/ssh/orcad-migration-cutover-journal'

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

// The listener is the oldest sshd; every other sshd/sshd-session is a live connection.
const DROP_SSH_CONNECTIONS = `
daemon="$(pgrep -x sshd | sort -n | head -1)"
for pid in $(pgrep -x sshd; pgrep -x sshd-session); do
  [ "$pid" = "$daemon" ] && continue
  kill -9 "$pid" 2>/dev/null
done
true
`

function bridgedPanes(page: Page): Promise<{ ptyId: string; state: string }[]> {
  return page.evaluate(async () => (await window.api.legacyRelayBridge?.listPanes()) ?? [])
}

/** The managed server's status for each pane of a migrated tab; `ready` means it runs a shell. */
async function serverPaneStatuses(
  page: Page,
  environmentId: string,
  worktreeId: string,
  tabId: string
): Promise<string[]> {
  const listed: unknown = JSON.parse(
    await serverCall(page, environmentId, 'session.tabs.list', { worktree: `id:${worktreeId}` })
  )
  const tabs = z
    .object({ result: z.object({ tabs: z.array(z.record(z.string(), z.unknown())) }) })
    .parse(listed).result.tabs
  return tabs
    .filter((tab) => tab.type === 'terminal' && tab.parentTabId === tabId)
    .map((tab) => String(tab.status))
}

async function typeIntoActiveTerminal(page: Page, line: string): Promise<void> {
  await focusActiveTerminalInput(page)
  await page.keyboard.type(line, { delay: 20 })
  await page.keyboard.press('Enter')
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

function writeOverLimitScrollbackSnapshot(userDataDir: string, ref: string): void {
  const snapshotRoot = getProfileTerminalScrollbackSnapshotRoot(
    getOrcaProfileDataFile(DEFAULT_LOCAL_ORCA_PROFILE_ID, userDataDir)
  )
  const path = getTerminalScrollbackSnapshotPath(ref, { snapshotRoot })
  if (!path) {
    throw new Error(`Expected a valid scrollback ref, got ${ref}`)
  }
  mkdirSync(snapshotRoot, { recursive: true })
  writeFileSync(path, '')
  truncateSync(path, TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT + 1)
}

async function verifyRunningRelayUpgrade(
  testRepoPath: string,
  testInfo: TestInfo,
  unreadableScrollback = false
): Promise<void> {
  test.setTimeout(25 * 60_000)
  host = startDockerSshHostTarget(testInfo)
  const targetId = `ssh-bridge-${Date.now()}`
  const relay = await installReleasedRelayOnDockerHost(host, TEMPLATE_SOURCE!)
  const ours = await startDockerRelayWithShell(host, relay, targetId, 'before-upgrade')
  const theirs = await startDockerRelayWithShell(host, relay, 'another-desktop', 'theirs')
  const bridgedPtyId = toAppSshPtyId(targetId, ours.relayPtyId)

  const session = createRestartSession(testInfo, { ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE_SOURCE! })
  let app: ElectronApplication | null = null
  try {
    // The first launch only establishes the profile the relay-era rows are written into.
    const first = await session.launch()
    app = first.app
    await waitForSessionReady(first.page)
    await first.page.evaluate((repoPath) => window.api.repos.add({ path: repoPath }), testRepoPath)
    await session.close(app)
    app = null
    const seeded = seedRelayEraProfile(
      session.userDataDir,
      {
        label: `legacy relay bridge E2E ${Date.now()}`,
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
    if (unreadableScrollback) {
      const ref = makeTerminalScrollbackSnapshotRef(terminalTabId, seeded.terminalLeafId)
      // A missing file is no history at all; an over-limit one is saved history Orca cannot read.
      writeOverLimitScrollbackSnapshot(session.userDataDir, ref)
      mutateStoppedProfileState(session.userDataDir, (state) => {
        const partitions = z
          .record(z.string(), workspaceSessionStateSchema)
          .parse(state.workspaceSessionsByHostId)
        const layout =
          partitions[toSshExecutionHostId(targetId)]?.terminalLayoutsByTabId[terminalTabId]
        if (!layout) {
          throw new Error('Expected the released terminal layout')
        }
        layout.scrollbackRefsByLeafId = { [seeded.terminalLeafId]: ref }
        state.workspaceSessionsByHostId = partitions
        state.sshRemotePtyLeases = [
          ...z.array(z.unknown()).parse(state.sshRemotePtyLeases),
          {
            targetId,
            ptyId: `old-${ours.relayPtyId}`,
            tabId: 'closed-tab',
            leafId: seeded.terminalLeafId,
            worktreeId: seeded.worktreeId,
            state: 'expired',
            supersededBy: ours.relayPtyId,
            createdAt: Date.now(),
            updatedAt: Date.now()
          }
        ]
      })
    }

    const upgraded = await launchUpgraded(session)
    app = upgraded.app
    const page = upgraded.page
    await waitForSessionReady(page)
    // Mounting the relay-era terminal tab dials the host, as the relay-era pane did.
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
        tabId: terminalTabId
      }
    )

    if (unreadableScrollback) {
      await expect
        .poll(() => managedServer(page, targetId), { timeout: 120_000 })
        .toMatchObject({ kind: 'relay', reason: 'refused', canLeaveBehind: true })
      // The refusal toast offers it too; this is the pane's own button.
      const move = page
        .getByRole('button', { name: 'Move anyway…', exact: true })
        .and(page.locator(':not([data-sonner-toast] button)'))
      await expect(move).toBeVisible()
      await page.screenshot({
        path: testInfo.outputPath('unreadable-history-recovery-offered.png')
      })
      await move.click()
      const dialog = page.getByRole('dialog')
      await expect(dialog).toContainText('saved terminal history Orca could not read')
      await page.screenshot({
        path: testInfo.outputPath('unreadable-history-recovery-confirm.png'),
        animations: 'disabled'
      })
      await dialog.getByRole('button', { name: 'Move anyway', exact: true }).click()
    }

    await expect
      .poll(() => managedServer(page, targetId), { timeout: 8 * 60_000 })
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
    // The old tab moved with the session to the managed server, which lists it for every client.
    await expect
      .poll(
        () =>
          serverCall(page, environment.id, 'session.tabs.list', {
            worktree: `id:${seeded.worktreeId}`
          }),
        { timeout: 60_000 }
      )
      .toContain(terminalTabId)
    // A reconnect hangs the bridge up and finds the old terminal again, as the next launch would.
    await reconnect(page, targetId)
    await expect
      .poll(() => bridgedPanes(page), { timeout: BRIDGE_TIMEOUT_MS })
      .toEqual([expect.objectContaining({ ptyId: bridgedPtyId, state: 'live' })])
    await page.evaluate(
      (hostId) => {
        window.__store!.getState().setGroupBy('none')
        window.__store!.setState({ visibleWorkspaceHostIds: ['local', hostId] })
      },
      `runtime:${environment.id}` as const
    )
    await expect(page.getByText('orcad upgrade folder', { exact: true })).toBeVisible({
      timeout: 120_000
    })
    // Opening the worktree loads its tabs from the managed server.
    await page.evaluate(
      ({ worktreeId, environmentId }) => {
        const state = window.__store!.getState()
        state.setActiveView('terminal')
        state.setActiveWorktree(worktreeId, `runtime:${environmentId}`)
      },
      { worktreeId: seeded.worktreeId, environmentId: environment.id }
    )
    // The client mirrors the server's tab as `web-terminal-<tab::leaf>`, under its worktree key.
    let storeTabId = ''
    let storeWorktreeKey = ''
    let seen = ''
    await expect
      .poll(
        async () => {
          const found = await page.evaluate((tabId) => {
            const all = window.__store!.getState().tabsByWorktree
            for (const [key, tabs] of Object.entries(all)) {
              for (const tab of tabs ?? []) {
                const host = tab.id.startsWith('web-terminal-')
                  ? decodeURIComponent(tab.id.slice('web-terminal-'.length))
                  : tab.id
                if (host === tabId || host.startsWith(`${tabId}::`)) {
                  return { key, id: tab.id, seen: '' }
                }
              }
            }
            return {
              key: '',
              id: '',
              seen: JSON.stringify(
                Object.fromEntries(
                  Object.entries(all).map(([key, tabs]) => [key, (tabs ?? []).map((t) => t.id)])
                )
              )
            }
          }, terminalTabId)
          storeTabId = found.id
          storeWorktreeKey = found.key
          seen = found.seen
          return storeTabId
        },
        { timeout: 120_000 }
      )
      .not.toBe('')
      .catch((error: unknown) => {
        throw new Error(`the client never mirrored the relay-era tab; saw ${seen}`, {
          cause: error
        })
      })
    // The old tab, now under the managed server, shows the old shell's screen and takes input.
    await page.evaluate(
      ({ worktreeId, environmentId, tabId }) => {
        const hostId = `runtime:${environmentId}` as const
        const state = window.__store!.getState()
        state.setGroupBy('none')
        window.__store!.setState({ visibleWorkspaceHostIds: ['local', hostId] })
        state.setActiveView('terminal')
        state.setActiveWorktree(worktreeId, hostId)
        state.setActiveTab(tabId)
        state.setActiveTabType('terminal', worktreeId)
      },
      { worktreeId: storeWorktreeKey, environmentId: environment.id, tabId: storeTabId }
    )
    await page.screenshot({ path: testInfo.outputPath('bridged-tab-activated.png') })
    await expect
      .poll(() => page.evaluate((id) => window.__paneManagers?.has(id) ?? false, storeTabId), {
        timeout: 120_000,
        message: 'the relay-era terminal tab never mounted under the managed server'
      })
      .toBe(true)
    await expectTerminalAccessibilityText(page, storeTabId, 'GOT:before-upgrade', BRIDGE_TIMEOUT_MS)
    await typeIntoActiveTerminal(page, 'after-upgrade')
    await expectTerminalAccessibilityText(page, storeTabId, 'GOT:after-upgrade')
    await page.screenshot({ path: testInfo.outputPath('bridged-terminal.png') })

    const fresh = await createPairedHostTerminal(page, environment.id, seeded.worktreeId, 'bash')
    await openPairedClientTab(page, seeded.worktreeId, fresh.webTabId)
    await callEnvironment(page, environment.id, 'terminal.send', {
      terminal: fresh.terminal,
      text: "printf 'QA_%s\\n' ORCAD_NEW",
      enter: true
    })
    await expectTerminalAccessibilityText(page, fresh.webTabId, 'QA_ORCAD_NEW')
    expect(await listDockerRelayPtys(host, relay, ours.sockPath)).toEqual([ours.relayPtyId])

    // Returning to the old tab must retain its shell without a hidden managed replacement.
    await page
      .locator(`[data-testid="sortable-tab"][data-tab-id=${JSON.stringify(storeTabId)}]`)
      .click()
    await expectTerminalAccessibilityText(page, storeTabId, 'GOT:after-upgrade')
    await page.waitForTimeout(10_000)
    const statuses = await serverPaneStatuses(
      page,
      environment.id,
      seeded.worktreeId,
      terminalTabId
    )
    expect(statuses.length).toBeGreaterThan(0)
    expect(statuses).not.toContain('ready')

    // Losing the SSH connection is never the old shell's death: it reattaches and still answers.
    execDockerSshHostTargetControlCommand(host, DROP_SSH_CONNECTIONS)
    await expect
      .poll(() => bridgedPanes(page), { timeout: BRIDGE_TIMEOUT_MS, intervals: [2_000] })
      .toEqual([expect.objectContaining({ ptyId: bridgedPtyId, state: 'live' })])
    await page.evaluate((tabId) => {
      const state = window.__store!.getState()
      state.setActiveView('terminal')
      state.setActiveTab(tabId)
      state.setActiveTabType('terminal', state.activeWorktreeId)
    }, storeTabId)
    await expect
      .poll(
        async () => {
          await typeIntoActiveTerminal(page, 'after-drop')
          return (
            (await page.evaluate((id) => {
              const manager = window.__paneManagers?.get(id)
              const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0]
              return pane?.serializeAddon?.serialize?.() ?? ''
            }, storeTabId)) ?? ''
          ).includes('GOT:after-drop')
        },
        { timeout: BRIDGE_TIMEOUT_MS, intervals: [5_000] }
      )
      .toBe(true)

    // Explicit disconnect replaces only the bridge; reconnect must reattach the same live relay shell.
    await reconnect(page, targetId)
    await expect
      .poll(() => bridgedPanes(page), { timeout: BRIDGE_TIMEOUT_MS, intervals: [2_000] })
      .toEqual([expect.objectContaining({ ptyId: bridgedPtyId, state: 'live' })])
    await page.evaluate((tabId) => {
      const state = window.__store!.getState()
      state.setActiveView('terminal')
      state.setActiveTab(tabId)
      state.setActiveTabType('terminal', state.activeWorktreeId)
    }, storeTabId)
    await expect
      .poll(
        async () => {
          await typeIntoActiveTerminal(page, 'after-reconnect')
          return (
            (await page.evaluate((id) => {
              const manager = window.__paneManagers?.get(id)
              const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0]
              return pane?.serializeAddon?.serialize?.() ?? ''
            }, storeTabId)) ?? ''
          ).includes('GOT:after-reconnect')
        },
        { timeout: BRIDGE_TIMEOUT_MS, intervals: [5_000] }
      )
      .toBe(true)

    // The old shell exits on its own: its pane and lease retire, and the bridge hangs up.
    await typeIntoActiveTerminal(page, 'quit')
    await expect.poll(() => bridgedPanes(page), { timeout: 60_000 }).toEqual([])
    // A relay left holding nothing may retire on its own grace, which also holds nothing.
    await expect
      .poll(() => listDockerRelayPtys(host!, relay, ours.sockPath).catch(() => []))
      .toEqual([])
    await session.close(app)
    app = null
    // Retired: terminated, and its tombstone pruned once nothing names it.
    const leases = readPersistedProfileState(session.userDataDir).sshRemotePtyLeases
    expect(
      (Array.isArray(leases) ? leases : []).filter(
        (lease: { ptyId?: unknown; state?: unknown }) =>
          lease.ptyId === ours.relayPtyId && lease.state !== 'terminated'
      )
    ).toEqual([])

    // Another desktop's relay keeps running its shell, in its directory, untouched.
    expect(await echoThroughDockerRelay(host, relay, theirs, 'still-here')).toContain(
      'GOT:still-here'
    )
    expect(
      execDockerSshHostTargetControlCommand(host, `test -d '${relay.dir}' && echo present`)
    ).toBe('present')
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
  }
}

test('terminals a 1.4.224 relay keeps running stay usable in their old tabs after upgrading', async ({
  testRepoPath
}, testInfo) => verifyRunningRelayUpgrade(testRepoPath, testInfo))

test('unreadable saved scrollback can be skipped while the original relay shell keeps working', async ({
  testRepoPath
}, testInfo) => verifyRunningRelayUpgrade(testRepoPath, testInfo, true))

test('a relay terminal in a project another desktop already moved keeps working until it exits (STA-10604)', async ({
  testRepoPath
}, testInfo: TestInfo) => {
  test.setTimeout(25 * 60_000)
  host = startDockerSshHostTarget(testInfo)
  const targetId = `ssh-bridge-joined-${Date.now()}`
  const relay = await installReleasedRelayOnDockerHost(host, TEMPLATE_SOURCE!)
  const ours = await startDockerRelayWithShell(host, relay, targetId, 'before-upgrade')
  const bridgedPtyId = toAppSshPtyId(targetId, ours.relayPtyId)
  const input = {
    label: `shared login bridge E2E ${Date.now()}`,
    host: host.host,
    port: host.port,
    username: 'root',
    identityFile: host.identityFile,
    identitiesOnly: true,
    relayGracePeriodSeconds: 1
  }
  const desktopA = createRestartSession(testInfo, { ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE_SOURCE! })
  const desktopB = createRestartSession(testInfo, { ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE_SOURCE! })
  let app: ElectronApplication | null = null
  try {
    const a = await desktopA.launch()
    app = a.app
    await waitForSessionReady(a.page)
    const serverA = await a.page.evaluate(async (target) => {
      const added = await window.api.ssh.addTarget({ target })
      return (await window.api.ssh.connect({ targetId: added.target.id }))?.managedServer ?? null
    }, input)
    if (serverA?.kind !== 'managed') {
      throw new Error(`desktop A expected a managed server, got ${JSON.stringify(serverA)}`)
    }
    await callEnvironment(a.page, serverA.environmentId, 'repo.add', {
      path: DOCKER_SSH_HOST_REMOTE_REPO_PATH
    })
    await desktopA.close(app)
    app = null

    const first = await desktopB.launch()
    app = first.app
    await waitForSessionReady(first.page)
    await first.page.evaluate((repoPath) => window.api.repos.add({ path: repoPath }), testRepoPath)
    await desktopB.close(app)
    app = null
    const seeded = seedRelayEraProfile(
      desktopB.userDataDir,
      input,
      { repoPath: DOCKER_SSH_HOST_REMOTE_REPO_PATH, folderPath: '/tmp' },
      { targetId, relayPtyId: ours.relayPtyId }
    )
    const terminalTabId = seeded.terminalTabId!
    const b = await launchUpgraded(desktopB)
    app = b.app
    const page = b.page
    await waitForSessionReady(page)
    // Mounting the relay-era terminal tab dials the host, as the relay-era pane did.
    await page.evaluate(
      ({ worktreeId, hostId, tabId }) => {
        const state = window.__store!.getState()
        state.setActiveView('terminal')
        state.setActiveWorktree(worktreeId, hostId)
        state.setActiveTab(tabId)
        state.setActiveTabType('terminal', worktreeId)
      },
      {
        worktreeId: seeded.worktreeId,
        hostId: toSshExecutionHostId(targetId),
        tabId: terminalTabId
      }
    )

    // Not moved, but connected: the card names the project's terminals; the old shell answers.
    await expect
      .poll(() => managedServer(page, targetId), { timeout: 8 * 60_000 })
      .toMatchObject({ kind: 'relay', reason: 'relay_terminals_live', bridged: true })
    expect(JSON.stringify(await managedServer(page, targetId))).toContain(
      DOCKER_SSH_HOST_REMOTE_REPO_PATH
    )
    expect(
      await page.evaluate(
        (id) => window.__store!.getState().sshConnectionStates.get(id)?.status,
        targetId
      )
    ).toBe('connected')
    await expect
      .poll(() => bridgedPanes(page), { timeout: BRIDGE_TIMEOUT_MS })
      .toEqual([expect.objectContaining({ ptyId: bridgedPtyId, state: 'live' })])
    await expectTerminalAccessibilityText(
      page,
      terminalTabId,
      'GOT:before-upgrade',
      BRIDGE_TIMEOUT_MS
    )
    await typeIntoActiveTerminal(page, 'still-bridged')
    await expectTerminalAccessibilityText(page, terminalTabId, 'GOT:still-bridged')
    await page.screenshot({ path: testInfo.outputPath('unmoved-bridged-terminal.png') })

    await typeIntoActiveTerminal(page, 'quit')
    await expect.poll(() => bridgedPanes(page), { timeout: 60_000 }).toEqual([])
    await reconnect(page, targetId)
    await expect
      .poll(() => managedServer(page, targetId), { timeout: 8 * 60_000 })
      .toMatchObject({ kind: 'managed' })
    expect(findOrcadMigrationSourceCutoverForTarget(desktopB.userDataDir, targetId)).toMatchObject({
      linkedRepositoryIds: [seeded.repoId]
    })
  } finally {
    if (app) {
      // Either session's close quits whichever app is still running.
      await desktopB.close(app)
    }
    await desktopA.dispose()
    await desktopB.dispose()
  }
})

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
