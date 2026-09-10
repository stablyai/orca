import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { test as base, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { createRuntimeDesktopPairingOffer } from './helpers/paired-electron-client'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { RuntimeClient } from '../../src/cli/runtime-client'
import { startCompiledCliBridge } from './fixtures/orchestration-maestro-contract-hardening/compiled-cli-bridge'
import {
  bootstrapProjection,
  cleanupContractFixture,
  closeFixtureTerminals,
  configureContractWorker,
  createRun,
  createTaskFromStdin,
  discoverPublicWorkspaceKey,
  readWorkerLedger,
  sendWorkerMarker,
  startAttemptBoundWorker,
  updateTaskStatus,
  type CliInvoker,
  type RunFixture,
  type TaskFixture,
  type WorkerFixture
} from './fixtures/orchestration-maestro-contract-hardening/orchestration-contract-fixture'
import {
  captureDesktopEvidence,
  DESKTOP_PROFILES,
  setEvidenceTheme,
  setEvidenceViewport
} from './fixtures/orchestration-maestro-contract-hardening/progress-evidence'

const FIXTURE_ROOT = mkdtempSync(path.join(os.tmpdir(), 'orca-och-integ-'))
const CLI_ENTRY = path.resolve('out/cli/index.js')

const test = base.extend({
  launchEnv: [
    {
      ORCA_E2E_OCH_ROOT: FIXTURE_ROOT,
      ORCA_E2E_CLI_ENTRY: CLI_ENTRY
    },
    { option: true }
  ]
})

type ProgressResponse = {
  schemaVersion: number | null
  progress: {
    schema_version?: number
    execution?: { state: string; progress_percent?: number; completed: number; total: number }
    nested_activity?: { label: string }[]
    cleanup_health?: { state: string; count: number }
  } | null
}

async function openActiveMaestro(
  page: Parameters<typeof setEvidenceTheme>[0],
  waitForCanvas = false
): Promise<void> {
  const maestroTabId = await page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    return worktreeId
      ? (state?.unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.contentType === 'maestro')
          ?.id ?? null)
      : null
  })
  if (!maestroTabId) {
    throw new Error('The active workspace did not expose its pinned Maestro tab')
  }
  const maestro = page.locator(
    `button[data-tab-id=${JSON.stringify(maestroTabId)}][aria-label="Maestro"]`
  )
  await expect(maestro).toHaveCount(1)
  await expect(maestro).toHaveAttribute('data-pinned', 'true')
  await maestro.click()
  if (waitForCanvas) {
    await expect
      .poll(() =>
        page.evaluate(() => {
          const state = window.__store?.getState()
          const worktreeId = state?.activeWorktreeId
          const groupId = worktreeId ? state?.activeGroupIdByWorktree[worktreeId] : null
          const group = worktreeId
            ? state?.groupsByWorktree[worktreeId]?.find((item) => item.id === groupId)
            : null
          return worktreeId
            ? (state?.unifiedTabsByWorktree[worktreeId]?.find(
                (tab) => tab.id === group?.activeTabId
              )?.contentType ?? null)
            : null
        })
      )
      .toBe('maestro')
    await expect(page.locator('[data-maestro-workspace-canvas]')).toBeVisible()
  }
}

async function waitForWorkerEvent(event: string, count = 1): Promise<void> {
  await expect
    .poll(() => readWorkerLedger(FIXTURE_ROOT).filter((entry) => entry.event === event).length, {
      timeout: 30_000
    })
    .toBe(count)
}

async function waitForTaskStatuses(
  bridge: CliInvoker,
  run: RunFixture,
  expected: Record<string, string>,
  cwd: string
): Promise<void> {
  await expect
    .poll(async () => {
      const listed = await bridge.invoke<{
        tasks: { id: string; status: string }[]
      }>(['orchestration', 'task-list', '--run', run.id, '--json'], { cwd })
      if (!listed.response.ok) {
        return {}
      }
      return Object.fromEntries(listed.response.result.tasks.map((task) => [task.id, task.status]))
    })
    .toMatchObject(expected)
}

async function expectChildSettlementRejected(): Promise<void> {
  const entry = readWorkerLedger(FIXTURE_ROOT).find(
    (candidate) => candidate.event === 'child-settlement'
  )
  expect(entry?.result?.status).toBe(1)
  const response = JSON.parse(entry?.result?.stdout ?? '{}') as {
    error?: { code?: string; message?: string }
  }
  expect(response.error).toEqual({
    code: 'sender_not_assignee_session',
    message: expect.any(String)
  })
}

async function captureActiveEvidence(page: Parameters<typeof setEvidenceTheme>[0]): Promise<void> {
  await setEvidenceTheme(page, 'dark')
  for (const profile of DESKTOP_PROFILES) {
    await captureDesktopEvidence({
      page,
      id: `och-active-expanded-${profile.id}`,
      profile
    })
  }
}

async function captureBlockedEvidence(page: Parameters<typeof setEvidenceTheme>[0]): Promise<void> {
  await setEvidenceTheme(page, 'light')
  for (const profile of DESKTOP_PROFILES) {
    await captureDesktopEvidence({
      page,
      id: `och-blocked-nested-${profile.id}`,
      profile
    })
  }
}

async function captureCompletedEvidence(
  page: Parameters<typeof setEvidenceTheme>[0]
): Promise<void> {
  await setEvidenceTheme(page, 'dark')
  for (const profile of DESKTOP_PROFILES) {
    await captureDesktopEvidence({
      page,
      id: `och-complete-warning-${profile.id}`,
      profile
    })
  }
}

async function captureVisibilityEvidence(page: Parameters<typeof setEvidenceTheme>[0]) {
  await setEvidenceTheme(page, 'dark')
  const desktop = DESKTOP_PROFILES[0]
  await page.getByRole('button', { name: 'Compact Run panel' }).click()
  await captureDesktopEvidence({ page, id: 'och-compact-desktop', profile: desktop })
  await page.getByRole('button', { name: 'Hide Run panel' }).click()
  for (const profile of DESKTOP_PROFILES) {
    await captureDesktopEvidence({
      page,
      id: `och-hidden-restore-${profile.id}`,
      profile
    })
  }
  await page.getByRole('button', { name: 'Restore Run progress panel' }).click()
  await page.getByRole('button', { name: 'Expand Run panel' }).click()
}

type FolderOrchestrationHome = { id: string; path: string }

async function createFolderOrchestrationHome(
  page: Parameters<typeof setEvidenceTheme>[0]
): Promise<FolderOrchestrationHome> {
  const folderPath = path.join(FIXTURE_ROOT, 'folder-workspace')
  mkdirSync(folderPath, { recursive: true })
  const folderId = await page.evaluate(async (workspacePath) => {
    const state = window.__store?.getState()
    const group = await state?.createProjectGroup('OCH orchestration home')
    if (!state || !group) {
      throw new Error('Could not create the folder orchestration-home project group')
    }
    const workspace = await state.createFolderWorkspace({
      projectGroupId: group.id,
      name: 'OCH orchestration home',
      folderPath: workspacePath
    })
    if (!workspace) {
      throw new Error('Could not create the folder orchestration-home workspace')
    }
    state.setActiveFolderWorkspace(workspace.id)
    return workspace.id
  }, folderPath)
  await expect
    .poll(() => page.evaluate(() => window.__store?.getState().activeWorktreeId))
    .toBe(`folder:${folderId}`)
  return { id: folderId, path: folderPath }
}

async function verifyFolderBootstrap(args: {
  page: Parameters<typeof setEvidenceTheme>[0]
  bridge: CliInvoker
  home: FolderOrchestrationHome
  userDataDir: string
}): Promise<void> {
  args.page.evaluate((folderId) => {
    window.__store?.getState().setActiveFolderWorkspace(folderId)
  }, args.home.id)
  await expect
    .poll(() => args.page.evaluate(() => window.__store?.getState().activeWorktreeId))
    .toBe(`folder:${args.home.id}`)

  const run = await createRun(args.bridge, 'Bootstrap an ordinary folder workspace', args.home.path)
  const localClient = new RuntimeClient(args.userDataDir, 30_000, null, null)
  const layout = await localClient.call<{ outcome: string; revision: number }>(
    'maestro.document.layout.apply',
    {
      schema_version: 1,
      protocol: 'maestro-document-layout-mutation/v1',
      mutation_id: 'och-folder-layout',
      scope: { execution_host_id: 'local', workspace_key: `folder:${args.home.id}` },
      expected_revision: 0,
      operation: { kind: 'set-viewport', viewport: { center: { x: 0, y: 0 }, zoom: 1 } }
    }
  )
  expect(layout.result).toMatchObject({ outcome: 'applied', revision: 1 })
  const documentOnly = await args.bridge.invoke<{
    documentState: string
    projectionState: string
  }>(['maestro', 'show', '--host', 'local', '--workspace', `folder:${args.home.id}`, '--json'], {
    cwd: args.home.path
  })
  expect(documentOnly.response).toMatchObject({
    ok: true,
    result: { documentState: 'ready', projectionState: 'empty' }
  })
  const receipt = await bootstrapProjection({
    bridge: args.bridge,
    run,
    workspaceKey: `folder:${args.home.id}`,
    cwd: args.home.path,
    mutationId: 'och-folder-bootstrap'
  })
  expect(receipt).toMatchObject({
    outcome: 'published',
    projection_revision: 0,
    workspace_scope: {
      base_revision: expect.stringMatching(/^folder-observation:/),
      dirty_paths: []
    }
  })
  const authored = await args.bridge.invoke(
    ['maestro', 'author', '--payload-file', '-', '--json'],
    {
      cwd: args.home.path,
      input: JSON.stringify({
        schema_version: 1,
        protocol: 'maestro-document-authoring-mutation/v1',
        mutation_id: 'och-folder-document-only',
        scope: {
          repository_id: args.home.id,
          execution_host_id: 'local',
          workspace_key: `folder:${args.home.id}`,
          run_id: run.id
        },
        expected_revision: 1,
        operation: {
          kind: 'create-note',
          node_id: 'folder-bootstrap-note',
          position: { x: 24, y: 24 },
          title: 'Folder bootstrap note',
          markdown: 'Document state exists before a projection is published.'
        }
      })
    }
  )
  expect(authored.response).toMatchObject({
    ok: true,
    result: { outcome: 'applied', revision: 2 }
  })
  const folderState = await args.bridge.invoke<{
    documentState: string
    projectionState: string
  }>(['maestro', 'show', '--host', 'local', '--workspace', `folder:${args.home.id}`, '--json'], {
    cwd: args.home.path
  })
  expect(folderState.response).toMatchObject({
    ok: true,
    result: { documentState: 'ready', projectionState: 'ready' }
  })
  const offer = await createRuntimeDesktopPairingOffer(args.page)
  const compiledPairing = (await import(
    pathToFileURL(path.resolve('out/shared/pairing.js')).href
  )) as {
    decodePairingOffer(url: string): unknown
  }
  const compiledRemoteClient = (await import(
    pathToFileURL(path.resolve('out/shared/remote-runtime-client.js')).href
  )) as {
    sendRemoteRuntimeRequest(
      pairing: unknown,
      method: string,
      params: unknown,
      timeoutMs: number,
      envelope?: unknown,
      signal?: AbortSignal,
      clientCapabilities?: readonly string[]
    ): Promise<unknown>
  }
  const pairing = compiledPairing.decodePairingOffer(offer.pairingUrl)
  const legacyProgressResponse = await compiledRemoteClient.sendRemoteRuntimeRequest(
    pairing,
    'maestro.runProgress.get',
    {
      scope: { execution_host_id: 'local', workspace_key: `folder:${args.home.id}` }
    },
    30_000,
    undefined,
    undefined,
    []
  )
  expect(legacyProgressResponse).toMatchObject({
    ok: true,
    result: { schemaVersion: 1, progress: expect.any(Object) }
  })
  const legacyRemoteResponse = await compiledRemoteClient.sendRemoteRuntimeRequest(
    pairing,
    'orchestration.workspaceBootstrapReceipt',
    {
      runId: run.id,
      orchestrationHomeSelector: `folder:${args.home.id}`,
      executionWorkspaceSelector: `folder:${args.home.id}`,
      executionHostId: 'local'
    },
    30_000,
    undefined,
    undefined,
    ['maestro.bootstrap.v1']
  )
  expect(legacyRemoteResponse).toMatchObject({
    ok: false,
    error: { code: 'update_required' }
  })
}

test.afterAll(() => {
  cleanupContractFixture(FIXTURE_ROOT)
})

test('composes public bootstrap, actor authority, human progress, restart, and cleanup', async (// oxlint-disable-next-line no-empty-pattern -- This persistence check owns both Electron launches.
{}, testInfo) => {
  test.setTimeout(600_000)
  rmSync(path.join(FIXTURE_ROOT, 'worker-ledger.jsonl'), { force: true })
  const testRepoPath = existsSync(TEST_REPO_PATH_FILE)
    ? readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
    : ''
  test.skip(!testRepoPath || !existsSync(testRepoPath), 'Global setup did not produce a test repo')
  const session = createRestartSession(testInfo, {
    ORCA_E2E_OCH_ROOT: FIXTURE_ROOT,
    ORCA_E2E_CLI_ENTRY: CLI_ENTRY
  })
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null
  const first = await session.launch()
  firstApp = first.app
  const orcaPage = first.page
  await orcaPage.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  const gitWorktreeId = await attachRepoAndOpenTerminal(orcaPage, testRepoPath)
  await waitForSessionReady(orcaPage)
  expect(await waitForActiveWorktree(orcaPage)).toBe(gitWorktreeId)
  await ensureTerminalVisible(orcaPage)
  const userDataDir = session.userDataDir
  writeFileSync(path.join(FIXTURE_ROOT, 'user-data-path'), userDataDir)
  await createFolderOrchestrationHome(orcaPage)
  await ensureTerminalVisible(orcaPage)
  const client = new RuntimeClient(userDataDir, 30_000, null, null)
  let coordinator = await startCompiledCliBridge({
    page: orcaPage,
    root: path.join(FIXTURE_ROOT, 'git-coordinator'),
    userDataDir
  })
  const workers: WorkerFixture[] = []
  try {
    const workspaceKey = await discoverPublicWorkspaceKey(coordinator, testRepoPath)
    const run = await createRun(
      coordinator,
      'Harden orchestration and Maestro contracts',
      testRepoPath
    )
    const tasks: TaskFixture[] = [
      await createTaskFromStdin({
        bridge: coordinator,
        run,
        title: 'Bootstrap and actor authority',
        displayName: 'Runtime specialist',
        spec: 'Exercise public bootstrap and reject native child settlement.',
        cwd: testRepoPath
      }),
      await createTaskFromStdin({
        bridge: coordinator,
        run,
        title: 'Desktop and mobile evidence',
        displayName: 'Evidence specialist',
        spec: 'Validate human progress and platform evidence.',
        cwd: testRepoPath
      }),
      await createTaskFromStdin({
        bridge: coordinator,
        run,
        title: 'Approval and cleanup verification',
        displayName: 'Coordinator decision',
        spec: 'Confirm nested-agent authority before completion.',
        cwd: testRepoPath
      })
    ]
    const bootstrap = await bootstrapProjection({
      bridge: coordinator,
      run,
      workspaceKey,
      cwd: testRepoPath,
      mutationId: 'och-git-bootstrap'
    })
    expect(bootstrap).toMatchObject({ outcome: 'published', projection_revision: 0 })
    const replay = await bootstrapProjection({
      bridge: coordinator,
      run,
      workspaceKey,
      cwd: testRepoPath,
      mutationId: 'och-git-bootstrap'
    })
    expect(replay).toMatchObject({ outcome: 'replayed', projection_revision: 0 })

    const document = await coordinator.invoke<{
      documentState: string
      projectionState: string
      recoveryHint: string
    }>(['maestro', 'show', '--host', 'local', '--workspace', workspaceKey, '--json'], {
      cwd: testRepoPath
    })
    expect(document.response).toMatchObject({
      ok: true,
      result: { documentState: 'empty', projectionState: 'ready' }
    })
    const initialProjection = await coordinator.invoke<{
      runProgress: { available: boolean; state: string }
    }>(
      ['maestro', 'projection', 'show', '--host', 'local', '--workspace', workspaceKey, '--json'],
      { cwd: testRepoPath }
    )
    expect(initialProjection.response).toMatchObject({
      ok: true,
      result: { runProgress: { available: false, state: 'outcome_unknown' } }
    })

    await configureContractWorker(orcaPage, FIXTURE_ROOT)
    workers.push(
      await startAttemptBoundWorker({
        bridge: coordinator,
        client,
        task: tasks[0],
        cwd: testRepoPath,
        attemptId: 'attempt-och-runtime-1',
        workspaceKey
      }),
      await startAttemptBoundWorker({
        bridge: coordinator,
        client,
        task: tasks[1],
        cwd: testRepoPath,
        attemptId: 'attempt-och-evidence-1',
        workspaceKey
      })
    )
    await waitForWorkerEvent('ready', 2)

    await orcaPage.evaluate((worktreeId) => {
      window.__store?.getState().setActiveWorktree(worktreeId)
    }, gitWorktreeId)
    await openActiveMaestro(orcaPage, true)
    const progressPanel = orcaPage.getByRole('complementary', { name: 'Run progress' })
    await expect(progressPanel).toContainText('Harden orchestration and Maestro contracts', {
      timeout: 30_000
    })
    await expect(progressPanel).toContainText('Validating public bootstrap')
    await captureActiveEvidence(orcaPage)
    await captureVisibilityEvidence(orcaPage)

    await setEvidenceViewport(orcaPage, DESKTOP_PROFILES[1])
    await progressPanel.getByRole('button', { name: /Bootstrap and actor authority/ }).click()
    await expect
      .poll(() =>
        orcaPage.evaluate(() => {
          const state = window.__store?.getState()
          const worktreeId = state?.activeWorktreeId
          const groupId = worktreeId ? state?.activeGroupIdByWorktree[worktreeId] : null
          return worktreeId && groupId
            ? state?.groupsByWorktree[worktreeId]?.find((group) => group.id === groupId)
                ?.activeTabId
            : null
        })
      )
      .toBe(workers[0].tabId)
    await openActiveMaestro(orcaPage, true)

    await sendWorkerMarker(FIXTURE_ROOT, workers[0], 'OCH_START_CHILD')
    await waitForWorkerEvent('child-started')
    await expect
      .poll(
        () =>
          orcaPage.evaluate((taskId) => {
            const statuses = Object.values(window.__store?.getState().agentStatusByPaneKey ?? {})
            const status = statuses.find((entry) => entry.orchestration?.taskId === taskId)
            return {
              providerSessionId: status?.providerSession?.id ?? null,
              subagents: status?.subagents ?? []
            }
          }, tasks[0].id),
        { timeout: 10_000 }
      )
      .toMatchObject({
        providerSessionId: expect.any(String),
        subagents: [expect.objectContaining({ description: '/root/accessibility_review' })]
      })
    await updateTaskStatus({
      bridge: coordinator,
      run,
      task: tasks[2],
      status: 'blocked',
      cwd: testRepoPath
    })
    await openActiveMaestro(orcaPage, true)
    await expect(progressPanel).toContainText('Native child activity', { timeout: 30_000 })
    await expect(progressPanel).toContainText('accessibility_review')
    await expect(progressPanel).toContainText('Blocked')
    await captureBlockedEvidence(orcaPage)

    await updateTaskStatus({
      bridge: coordinator,
      run,
      task: tasks[2],
      status: 'completed',
      cwd: testRepoPath,
      result: 'Coordinator verified the child authority boundary.'
    })
    await sendWorkerMarker(FIXTURE_ROOT, workers[0], 'OCH_CHILD_SETTLE')
    await waitForWorkerEvent('child-settlement')
    await expectChildSettlementRejected()
    await waitForTaskStatuses(coordinator, run, { [tasks[0].id]: 'dispatched' }, testRepoPath)

    await sendWorkerMarker(FIXTURE_ROOT, workers[0], 'OCH_COMPLETE_CHILD')
    await waitForWorkerEvent('child-completed')
    await expect
      .poll(
        () =>
          orcaPage.evaluate((taskId) => {
            const statuses = Object.values(window.__store?.getState().agentStatusByPaneKey ?? {})
            return statuses.find((entry) => entry.orchestration?.taskId === taskId)?.subagents ?? []
          }, tasks[0].id),
        { timeout: 10_000 }
      )
      .toEqual([])
    await sendWorkerMarker(FIXTURE_ROOT, workers[0], 'OCH_PARENT_SETTLE')
    await waitForWorkerEvent('parent-settlement')
    await sendWorkerMarker(FIXTURE_ROOT, workers[1], 'OCH_PARENT_SETTLE')
    await waitForWorkerEvent('parent-settlement', 2)
    await waitForTaskStatuses(
      coordinator,
      run,
      {
        [tasks[0].id]: 'completed',
        [tasks[1].id]: 'completed',
        [tasks[2].id]: 'completed'
      },
      testRepoPath
    )
    for (const worker of workers) {
      const retained = await coordinator.invoke<{ state: string }>(
        ['orchestration', 'worker-retain', '--dispatch', worker.dispatchId, '--json'],
        { cwd: testRepoPath }
      )
      expect(retained.response).toMatchObject({ ok: true, result: { state: 'retained' } })
    }
    const progress = await client.call<ProgressResponse>('maestro.runProgress.get', {
      scope: { execution_host_id: 'local', workspace_key: workspaceKey }
    })
    expect(progress.result).toMatchObject({
      schemaVersion: 2,
      progress: {
        schema_version: 2,
        execution: { state: 'completed', progress_percent: 100, completed: 3, total: 3 },
        cleanup_health: { state: 'pending', count: 2 }
      }
    })
    await openActiveMaestro(orcaPage, true)
    await expect(progressPanel).toContainText('Completed', { timeout: 30_000 })
    await expect(progressPanel).toContainText('100%')
    await expect(progressPanel).toContainText('Cleanup')
    await expect(progressPanel).toContainText('The worker completed its bounded integration task.')
    await progressPanel.getByText('Technical details').click()
    await progressPanel.getByRole('button', { name: 'Copy Run' }).click()
    await expect.poll(() => orcaPage.evaluate(() => navigator.clipboard.readText())).toBe(run.id)
    await captureCompletedEvidence(orcaPage)

    await sendWorkerMarker(FIXTURE_ROOT, workers[0], 'OCH_EXIT')
    await waitForWorkerEvent('exit-requested')
    const released = await coordinator.invoke<{ state: string; processAction: string }>(
      ['orchestration', 'worker-release', '--dispatch', workers[0].dispatchId, '--json'],
      { cwd: testRepoPath }
    )
    expect(released.response).toMatchObject({
      ok: true,
      result: { state: 'released', processAction: 'closed_exited_terminal' }
    })

    await sendWorkerMarker(FIXTURE_ROOT, workers[1], 'OCH_EXIT')
    await waitForWorkerEvent('exit-requested', 2)
    const secondReleased = await coordinator.invoke<{ state: string; processAction: string }>(
      ['orchestration', 'worker-release', '--dispatch', workers[1].dispatchId, '--json'],
      { cwd: testRepoPath }
    )
    expect(secondReleased.response).toMatchObject({
      ok: true,
      result: { state: 'released', processAction: 'closed_exited_terminal' }
    })

    await coordinator.close()
    await session.close(firstApp)
    firstApp = null
    const second = await session.launch()
    secondApp = second.app
    await waitForSessionReady(second.page)
    coordinator = await startCompiledCliBridge({
      page: second.page,
      root: path.join(FIXTURE_ROOT, 'git-coordinator-after-restart'),
      userDataDir
    })
    for (const worker of workers) {
      const restartedWorker = await coordinator.invoke<{
        terminalResource: { releaseState: string } | null
      }>(['orchestration', 'worker-show', '--dispatch', worker.dispatchId, '--json'], {
        cwd: testRepoPath
      })
      expect(restartedWorker.response).toMatchObject({
        ok: true,
        result: { terminalResource: { releaseState: 'released' } }
      })
    }

    await coordinator.close()
    const orchestrationHome = await createFolderOrchestrationHome(second.page)
    await ensureTerminalVisible(second.page)
    coordinator = await startCompiledCliBridge({
      page: second.page,
      root: path.join(FIXTURE_ROOT, 'folder-coordinator-after-restart'),
      userDataDir
    })

    await verifyFolderBootstrap({
      page: second.page,
      bridge: coordinator,
      home: orchestrationHome,
      userDataDir
    })
  } finally {
    await closeFixtureTerminals(
      client,
      workers.map((worker) => worker.handle)
    )
    await coordinator.close()
    for (const app of [secondApp, firstApp]) {
      if (app) {
        await session.close(app).catch(() => undefined)
      }
    }
    await session.dispose()
  }
})
