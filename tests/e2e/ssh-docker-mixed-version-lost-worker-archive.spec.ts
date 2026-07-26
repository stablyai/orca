import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'

import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../src/shared/orca-profiles'
import { test, expect } from './helpers/orca-app'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import {
  clearDockerRelayProbe,
  createDockerRelayProbe,
  patchDockerRelayBundle,
  readDockerRelayProbe,
  type DockerRelayProbe,
  type DockerRelayReviveMode
} from './helpers/docker-ssh-relay-bundle-patch'
import {
  assertDockerRelaySessionCaptured,
  capturedDockerRelayWorkspacePtyCount,
  installDockerRelaySessionCapture,
  installDockerRelaySnapshotCaptureProbe,
  readDockerRelaySnapshotCaptures,
  reconnectCapturedDockerRelay,
  releaseDockerRelaySessionCapture
} from './helpers/docker-ssh-relay-session-capture'
import {
  cleanupDockerSshRelayTarget,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { createRestartSession } from './helpers/orca-restart'
import { getActiveTabId, getActiveWorktreeId, waitForSessionReady } from './helpers/store'
import {
  splitActiveTerminalPane,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'

type PersistedData = {
  terminalArchivesById?: Record<string, { reason?: string; sourceTabId?: string }>
  workspaceSessionsByHostId?: Record<
    string,
    {
      tabsByWorktree?: Record<string, { id?: string }[]>
      unifiedTabs?: Record<string, { entityId?: string; id?: string }[]>
    }
  >
}

type DockerRelayScenario = {
  app: ElectronApplication
  page: Page
  probe: DockerRelayProbe
  ptyId: string
  tabId: string
  target: DockerSshRelayTarget
  targetId: string
  userDataDir: string
  worktreeId: string
}

type DurableRelayState = {
  archiveIds: string[]
  tabInTabsByWorktree: boolean
  tabInUnifiedTabs: boolean
}

function readArchiveRows(userDataDir: string, tabId: string): string[] {
  return readDurableRelayState(userDataDir, '', tabId, '').archiveIds
}

function readDurableRelayState(
  userDataDir: string,
  targetId: string,
  tabId: string,
  worktreeId: string
): DurableRelayState {
  const statePath = path.join(
    userDataDir,
    'profiles',
    DEFAULT_LOCAL_ORCA_PROFILE_ID,
    'orca-data.json'
  )
  if (!existsSync(statePath)) {
    return {
      archiveIds: [],
      tabInTabsByWorktree: false,
      tabInUnifiedTabs: false
    }
  }
  const data = JSON.parse(readFileSync(statePath, 'utf8')) as PersistedData
  const session = targetId ? data.workspaceSessionsByHostId?.[`ssh:${targetId}`] : undefined
  return {
    archiveIds: Object.entries(data.terminalArchivesById ?? {})
      .filter(
        ([, archive]) => archive.reason === 'relay-worker-lost' && archive.sourceTabId === tabId
      )
      .map(([archiveId]) => archiveId),
    tabInTabsByWorktree: (session?.tabsByWorktree?.[worktreeId] ?? []).some(
      (tab) => tab.id === tabId
    ),
    tabInUnifiedTabs: (session?.unifiedTabs?.[worktreeId] ?? []).some(
      (tab) => tab.id === tabId || tab.entityId === tabId
    )
  }
}

async function waitForTerminal(page: Page): Promise<{ ptyId: string; tabId: string }> {
  await waitForActiveTerminalManager(page, 60_000)
  const ptyId = await waitForActivePanePtyId(page, 60_000)
  const tabId = await getActiveTabId(page)
  if (!tabId) {
    throw new Error('Remote terminal did not expose an active tab ID')
  }
  return { ptyId, tabId }
}

async function withDockerRelayScenario(
  testInfo: TestInfo,
  mode: DockerRelayReviveMode,
  run: (scenario: DockerRelayScenario) => Promise<void>
): Promise<void> {
  const probe = createDockerRelayProbe(`${mode}-${testInfo.workerIndex}`)
  const restorePatchedBundle = patchDockerRelayBundle(mode, probe)
  const restartSession = createRestartSession(testInfo)
  let app: ElectronApplication | null = null
  let target: DockerSshRelayTarget | null = null
  try {
    const launch = await restartSession.launch()
    app = launch.app
    await waitForSessionReady(launch.page)
    for (const platform of ['linux-x64', 'linux-arm64']) {
      expect(
        readFileSync(path.join(process.cwd(), 'out', 'relay', platform, 'relay.js'), 'utf8')
      ).toContain('__orcaE2eRelayMixedVersionMarker')
    }
    expect(await app.evaluate((_electron) => process.env.ORCA_RELAY_PATH ?? null)).toBe(
      path.join(process.cwd(), 'out', 'relay')
    )
    await installDockerRelaySessionCapture(app)
    target = startDockerSshRelayTarget(testInfo)
    const remote = await connectDockerSshRelayTarget(launch.page, target)
    await assertDockerRelaySessionCaptured(app, remote.targetId)
    const { ptyId, tabId } = await waitForTerminal(launch.page)
    const worktreeId = await getActiveWorktreeId(launch.page)
    if (!worktreeId) {
      throw new Error('Remote terminal did not expose an active worktree ID')
    }
    await expect
      .poll(() => readDockerRelayProbe(target!, probe.loadedPath), {
        timeout: 30_000,
        message: 'patched Docker relay did not write its unconditional load marker'
      })
      .toContain('loaded')
    await expect
      .poll(() => readDockerRelayProbe(target!, probe.spawnPath), {
        timeout: 30_000,
        message: 'relay pty.spawn probe missed the initial remote shell positive control'
      })
      .toEqual(['spawn'])
    const liveMarker = `RELAY_RECONNECT_LIVE_${Date.now()}`
    await launch.page
      .locator(`[data-pty-id=${JSON.stringify(ptyId)}] .xterm-helper-textarea`)
      .focus()
    await launch.page.keyboard.type(`printf '${liveMarker}\\n'`)
    await launch.page.keyboard.press('Enter')
    await waitForTerminalOutput(launch.page, liveMarker)
    clearDockerRelayProbe(target, probe)
    await run({
      app,
      page: launch.page,
      probe,
      ptyId,
      tabId,
      target,
      targetId: remote.targetId,
      userDataDir: restartSession.userDataDir,
      worktreeId
    })
  } finally {
    if (app) {
      await releaseDockerRelaySessionCapture(app)
    }
    cleanupDockerSshRelayTarget(target)
    if (app) {
      await restartSession.close(app)
    }
    await restartSession.dispose()
    restorePatchedBundle()
  }
}

async function reconnectScenario(scenario: DockerRelayScenario): Promise<void> {
  await reconnectCapturedDockerRelay(scenario.app, scenario.targetId)
}

async function waitForSingleArchive(
  scenario: DockerRelayScenario,
  diagnostic?: unknown
): Promise<string> {
  let archiveId: string | undefined
  await expect
    .poll(() => readArchiveRows(scenario.userDataDir, scenario.tabId), {
      timeout: 30_000,
      message: `typed recognized relay loss did not create a durable archive${
        diagnostic ? `; diagnostic=${JSON.stringify(diagnostic)}` : ''
      }`
    })
    .toHaveLength(1)
  archiveId = readArchiveRows(scenario.userDataDir, scenario.tabId)[0]
  if (!archiveId) {
    throw new Error('Durable relay-worker-lost archive has no ID')
  }
  return archiveId
}

async function typedArchiveDurabilityProbe(
  scenario: DockerRelayScenario
): Promise<DurableRelayState> {
  let durable: DurableRelayState | undefined
  await expect
    .poll(
      () => {
        durable = readDurableRelayState(
          scenario.userDataDir,
          scenario.targetId,
          scenario.tabId,
          scenario.worktreeId
        )
        return durable.archiveIds.length
      },
      { timeout: 30_000, message: 'typed recognized relay loss did not write its durable archive' }
    )
    .toBe(1)
  if (!durable) {
    throw new Error('Typed relay archive durability probe did not produce a state')
  }
  return durable
}

async function inspectTabDom(page: Page, tabId: string): Promise<unknown[]> {
  return page.evaluate((expectedTabId) => {
    return Array.from(document.querySelectorAll<HTMLElement>('[data-tab-id]'))
      .filter((element) => element.dataset.tabId === expectedTabId)
      .map((element) => ({
        className: element.className,
        dataTestId: element.dataset.testid ?? null,
        role: element.getAttribute('role'),
        tagName: element.tagName,
        text: element.textContent?.trim() ?? ''
      }))
  }, tabId)
}

test.describe('Docker SSH mixed-version lost-worker archive', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'Docker SSH relay fixture uses a Linux relay bundle.')

  // oxlint-disable-next-line no-empty-pattern -- Playwright fixture callbacks require object destructuring here.
  test('archives a typed recognized worker without creating a replacement shell', async ({}, testInfo) => {
    test.slow()
    await withDockerRelayScenario(testInfo, 'typed-lost', async (scenario) => {
      await reconnectScenario(scenario)

      await expect
        .poll(() => readDockerRelayProbe(scenario.target, scenario.probe.capabilityPath))
        .toEqual(['capability:typed', 'capability:typed'])
      await expect
        .poll(() => readDockerRelayProbe(scenario.target, scenario.probe.revivePath))
        .toEqual(['revive:typed'])
      const archiveId = await waitForSingleArchive(scenario)
      await typedArchiveDurabilityProbe(scenario)
      await expect.poll(() => inspectTabDom(scenario.page, scenario.tabId)).toEqual([])
      await expect
        .poll(() =>
          scenario.page.locator(`[data-pty-id=${JSON.stringify(scenario.ptyId)}]`).count()
        )
        .toBe(0)
      const durable = readDurableRelayState(
        scenario.userDataDir,
        scenario.targetId,
        scenario.tabId,
        scenario.worktreeId
      )
      const remainingTabDom = await inspectTabDom(scenario.page, scenario.tabId)
      const remainingPtyDom = await scenario.page
        .locator(`[data-pty-id=${JSON.stringify(scenario.ptyId)}]`)
        .count()
      expect(
        {
          durable,
          remainingPtyDom,
          remainingTabDom
        },
        'typed archive must retire the main durable tab and remove every DOM tab node'
      ).toEqual({
        durable: {
          archiveIds: [archiveId],
          tabInTabsByWorktree: false,
          tabInUnifiedTabs: false
        },
        remainingPtyDom: 0,
        remainingTabDom: []
      })
      await expect
        .poll(() =>
          scenario.page.locator(`[data-pty-id=${JSON.stringify(scenario.ptyId)}]`).count()
        )
        .toBe(0)
      await expect(
        scenario.page.locator(`[data-testid="sortable-tab"][data-tab-id="${scenario.tabId}"]`)
      ).toHaveCount(0)
      expect(readDockerRelayProbe(scenario.target, scenario.probe.spawnPath)).toEqual([])
      testInfo.annotations.push({ type: 'relay-worker-archive', description: archiveId })
    })
  })

  // oxlint-disable-next-line no-empty-pattern -- Playwright fixture callbacks require object destructuring here.
  test('keeps a legacy relay connected and retryable without inventing an archive', async ({}, testInfo) => {
    test.slow()
    await withDockerRelayScenario(testInfo, 'legacy', async (scenario) => {
      await reconnectScenario(scenario)

      await expect
        .poll(() => readDockerRelayProbe(scenario.target, scenario.probe.capabilityPath))
        .toEqual(['capability:legacy', 'capability:legacy'])
      await expect
        .poll(() => readDockerRelayProbe(scenario.target, scenario.probe.revivePath))
        .toEqual(['revive:legacy'])
      expect(readArchiveRows(scenario.userDataDir, scenario.tabId)).toEqual([])
      await expect(
        scenario.page.locator(`[data-testid="sortable-tab"][data-tab-id="${scenario.tabId}"]`)
      ).toHaveCount(1)
      await expect(
        scenario.page.locator(`[data-pty-id=${JSON.stringify(scenario.ptyId)}]`)
      ).toHaveCount(1)
      expect(readDockerRelayProbe(scenario.target, scenario.probe.spawnPath)).toEqual([])

      const retryMarker = `LEGACY_RELAY_RETRYABLE_${Date.now()}`
      await scenario.page.evaluate(
        ({ ptyId, marker }) => window.api.pty.write(ptyId, `printf '${marker}\\n'\r`),
        { ptyId: scenario.ptyId, marker: retryMarker }
      )
      await waitForTerminalOutput(scenario.page, retryMarker)
    })
  })

  // oxlint-disable-next-line no-empty-pattern -- Playwright fixture callbacks require object destructuring here.
  test('fails closed on a malformed typed response without a legacy revive retry', async ({}, testInfo) => {
    test.slow()
    await withDockerRelayScenario(testInfo, 'malformed', async (scenario) => {
      await reconnectScenario(scenario)

      await expect
        .poll(() => readDockerRelayProbe(scenario.target, scenario.probe.capabilityPath))
        .toEqual(['capability:typed', 'capability:typed'])
      await expect
        .poll(() => readDockerRelayProbe(scenario.target, scenario.probe.revivePath))
        .toEqual(['revive:typed'])
      expect(readArchiveRows(scenario.userDataDir, scenario.tabId)).toEqual([])
      await expect(
        scenario.page.locator(`[data-testid="sortable-tab"][data-tab-id="${scenario.tabId}"]`)
      ).toHaveCount(1)
      await expect(
        scenario.page.locator(`[data-pty-id=${JSON.stringify(scenario.ptyId)}]`)
      ).toHaveCount(1)
      expect(readDockerRelayProbe(scenario.target, scenario.probe.spawnPath)).toEqual([])
    })
  })

  // oxlint-disable-next-line no-empty-pattern -- Playwright fixture callbacks require object destructuring here.
  test('archives a split relay tab when a lost worker has a revived ordinary sibling', async ({}, testInfo) => {
    test.slow()
    await withDockerRelayScenario(testInfo, 'typed-mixed', async (scenario) => {
      await splitActiveTerminalPane(scenario.page, 'vertical')
      await expect
        .poll(() =>
          scenario.page.evaluate((tabId) => {
            return (window.__paneManagers?.get(tabId)?.getPanes?.() ?? [])
              .map((pane) => pane.container.dataset.ptyId)
              .filter((ptyId): ptyId is string => Boolean(ptyId))
          }, scenario.tabId)
        )
        .toHaveLength(2)
      await expect
        .poll(() => readDockerRelayProbe(scenario.target, scenario.probe.spawnPath))
        .toEqual(['spawn'])
      await expect
        .poll(() =>
          capturedDockerRelayWorkspacePtyCount(scenario.app, scenario.targetId, scenario.tabId)
        )
        .toBe(2)
      clearDockerRelayProbe(scenario.target, scenario.probe)
      await installDockerRelaySnapshotCaptureProbe(scenario.app, scenario.targetId)

      await reconnectScenario(scenario)

      await expect
        .poll(() => readDockerRelayProbe(scenario.target, scenario.probe.revivePath))
        .toEqual(['revive:typed'])
      const snapshotCaptures = await readDockerRelaySnapshotCaptures(scenario.app)
      await testInfo.attach('relay-split-snapshot-captures.json', {
        body: JSON.stringify(snapshotCaptures, null, 2),
        contentType: 'application/json'
      })
      expect(snapshotCaptures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            lostReplayTail: 'present',
            paneKeyMatchesLost: false,
            result: 'captured-bytes',
            sidecar: 'none',
            source: 'relay-tail'
          })
        ])
      )
      await waitForSingleArchive(scenario, snapshotCaptures)
      await expect(
        scenario.page.locator(`[data-testid="sortable-tab"][data-tab-id="${scenario.tabId}"]`)
      ).toHaveCount(0)
      await expect
        .poll(() =>
          scenario.page
            .locator(`[data-pty-id][data-tab-id=${JSON.stringify(scenario.tabId)}]`)
            .count()
        )
        .toBe(0)
      expect(readDockerRelayProbe(scenario.target, scenario.probe.spawnPath)).toEqual([])
    })
  })
})
