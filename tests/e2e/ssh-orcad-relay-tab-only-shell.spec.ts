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

/** Observe selection/catalog ownership without changing activation or retaining terminal bytes. */
function observeRelayTabSelection(
  page: Page,
  args: {
    targetId: string
    sshHostId: ReturnType<typeof toSshExecutionHostId>
    seededWorktreeId: string
    terminalTabId: string
  }
) {
  return page.evaluateHandle(({ targetId, sshHostId, seededWorktreeId, terminalTabId }) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable for relay selection observation')
    }
    const snapshot = () => {
      const state = store.getState()
      const connection = state.sshConnectionStates.get(targetId)
      const managed = connection?.managedServer
      const environmentId = managed?.kind === 'managed' ? managed.environmentId : null
      const runtimeHostId = environmentId
        ? (`runtime:${encodeURIComponent(environmentId)}` as const)
        : null
      const relevantTabs = Object.entries(state.tabsByWorktree)
        .flatMap(([key, tabs]) =>
          (tabs ?? []).flatMap((tab) => {
            const named = tab.id.startsWith('web-terminal-')
              ? decodeURIComponent(tab.id.slice('web-terminal-'.length))
              : tab.id
            return named === terminalTabId || named.startsWith(`${terminalTabId}::`)
              ? [{ key, id: tab.id }]
              : []
          })
        )
        .slice(0, 6)
      return {
        activeWorktreeId: state.activeWorktreeId,
        activeWorkspaceKey: state.activeWorkspaceKey,
        activeHostId: state.activeWorkspaceExecutionHostId,
        activeTabId: state.activeTabId,
        activeTabType: state.activeTabType,
        sshStatus: connection?.status ?? null,
        managedKind: managed?.kind ?? null,
        managedPhase: managed?.kind === 'setting-up' ? managed.phase : null,
        relayBridged: managed?.kind === 'relay' && managed.bridged === true,
        environmentId,
        visibleRelevantHosts:
          state.visibleWorkspaceHostIds?.filter(
            (id) => id === 'local' || id === sshHostId || id === runtimeHostId
          ) ?? null,
        runtimeCatalogPresent: state.runtimeEnvironments.some(
          (entry) => entry.id === environmentId
        ),
        runtimeCatalogHydrated: state.runtimeEnvironmentCatalogHydrated,
        runtimeCatalogSettled: state.runtimeEnvironmentCatalogSettled,
        startupScanFinished: state.startupWorktreeRefreshCompleted,
        seedKnownOnSsh: Boolean(state.getKnownWorktreeById(seededWorktreeId, sshHostId)),
        seedKnownOnRuntime: runtimeHostId
          ? Boolean(state.getKnownWorktreeById(seededWorktreeId, runtimeHostId))
          : false,
        relevantRepos: state.repos
          .filter(
            (repo) =>
              repo.connectionId === targetId ||
              (runtimeHostId && repo.executionHostId === runtimeHostId)
          )
          .slice(0, 6)
          .map((repo) => ({
            id: repo.id,
            hostId: repo.executionHostId ?? null,
            connectionId: repo.connectionId ?? null
          })),
        relevantTabs
      }
    }
    type Snapshot = ReturnType<typeof snapshot>
    type Event = {
      at: number
      stage: string
      before: Snapshot | null
      after: Snapshot
      stack?: string
    }
    const events: Event[] = []
    let dropped = 0
    let previous: Snapshot | null = null
    let selectedMirrorId: string | null = null
    let mirrored: { id: string; key: string } | null = null
    let firstDeselection: Event | null = null
    let firstMirrorRemoval: Event | null = null
    const record = (stage: string) => {
      const after = snapshot()
      if (stage === 'store' && JSON.stringify(previous) === JSON.stringify(after)) {
        return
      }
      const deselected = previous?.activeWorktreeId != null && after.activeWorktreeId === null
      const removed =
        selectedMirrorId !== null &&
        previous?.relevantTabs.some((tab) => tab.id === selectedMirrorId) &&
        !after.relevantTabs.some((tab) => tab.id === selectedMirrorId)
      const event: Event = { at: performance.now(), stage, before: previous, after }
      if ((deselected && !firstDeselection) || (removed && !firstMirrorRemoval)) {
        event.stack = new Error('Relay tab selection loss').stack?.slice(0, 6_000)
      }
      if (deselected && !firstDeselection) {
        firstDeselection = event
      }
      if (removed && !firstMirrorRemoval) {
        firstMirrorRemoval = event
      }
      if (
        after.relevantTabs.some(
          (tab) => tab.id === after.activeTabId && tab.id.startsWith('web-terminal-')
        )
      ) {
        selectedMirrorId = after.activeTabId
      }
      previous = after
      if (events.length === 80) {
        events.shift()
        dropped++
      }
      events.push(event)
    }
    record('before-activation')
    const unsubscribe = store.subscribe(() => record('store'))
    return {
      checkpoint: (input: {
        stage: string
        runtimeHostId?: string
        mirrored?: { id: string; key: string }
      }) => {
        if (input.mirrored) {
          mirrored = input.mirrored
        }
        record(input.stage)
        return { ...input, seededWorktreeId, selected: previous }
      },
      finish: () => {
        unsubscribe()
        record('finish')
        const tabId = mirrored?.id ?? selectedMirrorId ?? terminalTabId
        const manager = window.__paneManagers?.get(tabId)
        const panes = manager?.getPanes() ?? []
        const hasMarker = (pane: (typeof panes)[number], marker: string): boolean => {
          const buffer = pane.terminal.buffer.active
          for (let row = 0; row < buffer.length; row++) {
            if (buffer.getLine(row)?.translateToString(true).includes(marker)) {
              return true
            }
          }
          return false
        }
        const selector = `[data-terminal-tab-id="${CSS.escape(tabId)}"]`
        return {
          seededWorktreeId,
          sshHostId,
          terminalTabId,
          mirrored,
          events,
          dropped,
          firstDeselection,
          firstMirrorRemoval,
          dom: {
            tabId,
            managerCount: window.__paneManagers?.size ?? 0,
            paneCount: panes.length,
            tabInStrip: document.querySelector(`[data-tab-id="${CSS.escape(tabId)}"]`) !== null,
            terminalDom: document.querySelector(selector) !== null,
            accessibilityTree:
              document.querySelector(`${selector} .xterm-accessibility-tree`) !== null,
            panes: panes.slice(0, 4).map((pane) => ({
              leafId: pane.leafId,
              ptyId: pane.container.dataset.ptyId ?? null,
              screenReaderMode: pane.terminal.options.screenReaderMode === true,
              hasBeforeMoveMarker: hasMarker(pane, 'GOT:before-move'),
              hasAfterMoveMarker: hasMarker(pane, 'GOT:after-move')
            }))
          }
        }
      }
    }
  }, args)
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
  let selectionObserver: Awaited<ReturnType<typeof observeRelayTabSelection>> | null = null
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
    selectionObserver = await observeRelayTabSelection(page, {
      targetId,
      sshHostId,
      seededWorktreeId: seeded.worktreeId,
      terminalTabId
    })
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
    record.afterSshActivation = await selectionObserver.evaluate((observer) =>
      observer.checkpoint({ stage: 'after-ssh-activation' })
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
    record.afterRuntimeActivation = await selectionObserver.evaluate(
      (observer, runtimeHostId) =>
        observer.checkpoint({ stage: 'after-runtime-activation', runtimeHostId }),
      runtimeHostId
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
    record.afterMirrorActivation = await selectionObserver.evaluate(
      (observer, input) => observer.checkpoint({ stage: 'after-mirror-activation', ...input }),
      { runtimeHostId, mirrored }
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
    if (selectionObserver) {
      try {
        const evidence = await selectionObserver.evaluate((observer) => observer.finish())
        await testInfo.attach('tab-only-shell-selection', {
          body: JSON.stringify(evidence),
          contentType: 'application/json'
        })
      } catch (error) {
        record.selectionCaptureError = String(error)
      } finally {
        await selectionObserver.dispose().catch(() => {})
      }
    }
    writeFileSync(testInfo.outputPath('tab-only-shell.json'), JSON.stringify(record, null, 2))
    if (app) {
      await session.close(app)
    }
    await session.dispose()
  }
})
