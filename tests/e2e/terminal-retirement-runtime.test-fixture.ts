import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { vi } from 'vitest'
import {
  createStore,
  closeTestStores,
  testState
} from '../../src/main/persistence/persistence-test-harness'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import { createRuntimeAutomationService } from '../../src/main/automations/runtime-automation-service'
import { createHookListenerState } from '../../src/shared/agent-hook-listener/listener-state'
import { normalizeCodexEvent } from '../../src/shared/agent-hook-listener/providers/codex-events'
import {
  registerRetentionFixtureDirectory,
  retentionNow
} from './terminal-reuse-retention.test-fixture'
import { loadRetirementRenderer } from './terminal-retirement-renderer.test-fixture'

export async function setupRetirementRuntime() {
  const { randomUUID } = await import('node:crypto')
  const { AgentHookServer } = await import('../../src/main/agent-hooks/server')
  const { agentHookRuntimeDeps } =
    await import('../../src/main/agent-hooks/agent-hook-runtime-deps')
  const { AgentStatusObservedPaneIdentities, AgentStatusObservedPaneIdentityCapture } =
    await import('../../src/main/runtime/agent-status-observed-pane-identity')
  const { setRuntimeDesktopSurface } =
    await import('../../src/main/runtime/runtime-desktop-surface')
  const { stopStructuredAgentSessionRuntime } =
    await import('../../src/main/runtime/agent-session/structured-agent-session-runtime')
  const setupRetirementRenderer = await loadRetirementRenderer(setRuntimeDesktopSurface)
  const { parsePaneKey } = await import('../../src/shared/workspace-layout/stable-pane-id')
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-f17-close-'))
  registerRetentionFixtureDirectory(testState.dir)
  const store = createStore()
  const group = store.createProjectGroup({
    name: 'Probe',
    parentPath: testState.dir,
    createdFrom: 'manual'
  })
  const folder = store.createFolderWorkspace({
    projectGroupId: group.id,
    name: 'Probe',
    folderPath: testState.dir
  })
  store.addRepo({
    id: 'f17',
    path: testState.dir,
    displayName: 'Probe',
    badgeColor: '#fff',
    addedAt: 1,
    projectGroupId: group.id
  })
  const automation = store.createAutomation({
    name: 'Close probe',
    prompt: 'Reply OK',
    agentId: 'codex',
    enabled: false,
    projectId: 'f17',
    workspaceMode: 'existing',
    workspaceId: `folder:${folder.id}`,
    reuseSession: true,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: Date.now()
  })
  const server = new AgentHookServer()
  const identities = new AgentStatusObservedPaneIdentities()
  const capture = new AgentStatusObservedPaneIdentityCapture(identities)
  const runtime = new OrcaRuntimeService(
    store,
    undefined,
    agentHookRuntimeDeps(server, identities, () => store.getSettings())
  )
  capture.attach(runtime)
  const unsubscribe = server.subscribeEnrichedStatus((event) => capture.observe(event))
  const rendererFixture = await setupRetirementRenderer(store, runtime, automation.workspaceId!)
  const { renderer: useAppStore, publishRenderer, persistRenderer } = rendererFixture
  type Process = { id: string; incarnationId: string; cwd: string; title: string }
  const processes = new Map<string, Process>()
  const shell = new Set<string>()
  let nextPty = 0
  let seedTabId: string | undefined
  const membership = () => ({
    saved:
      store
        .getWorkspaceSession()
        .tabsByWorktree[automation.workspaceId!]?.some((tab) => tab.id === seedTabId) ?? false,
    layout: Boolean(seedTabId && store.getWorkspaceSession().terminalLayoutsByTabId[seedTabId]),
    raw:
      runtime['mobileSessionTabsByWorktree']
        .get(automation.workspaceId!)
        ?.tabs.some((tab) => tab.type === 'terminal' && tab.parentTabId === seedTabId) ?? false,
    renderer:
      useAppStore
        .getState()
        .tabsByWorktree[automation.workspaceId!]?.some((tab) => tab.id === seedTabId) ?? false
  })
  const stops: { id: string; incarnationId: string; membership: ReturnType<typeof membership> }[] =
    []
  const exits: Promise<unknown>[] = []
  const stop = (id: string) => {
    const process = processes.get(id)
    if (!process) {
      return false
    }
    stops.push({ id, incarnationId: process.incarnationId, membership: membership() })
    processes.delete(id)
    exits.push(Promise.resolve(runtime.onPtyExit(id, 0, process.incarnationId)))
    return true
  }
  runtime.setPtyController({
    spawn: async (options) => {
      const process = {
        id: `retention-pty-${nextPty++}`,
        incarnationId: randomUUID(),
        cwd: testState.dir,
        title: 'Codex'
      }
      processes.set(process.id, process)
      runtime.terminalRunFacts.recordSpawnCommit(process)
      options.onPtySpawnCommitted?.()
      return process
    },
    write: () => true,
    kill: stop,
    stopAndWait: async (id) => {
      const stopped = stop(id)
      await Promise.all(exits)
      return stopped
    },
    getForegroundProcess: async (id) => (shell.has(id) ? 'zsh' : 'codex'),
    confirmShellForeground: async (id) => shell.has(id),
    supportsForegroundObservation: () => true,
    inspectProcess: async (id) => ({
      verdict: 'unverifiable',
      reason: 'test-transport',
      ptyId: id,
      foregroundObservation: {
        ptyId: id,
        ptyIncarnationId: processes.get(id)!.incarnationId,
        authorityGeneration: 'retention',
        observationEpoch: 1,
        capturedAgeMs: 0,
        verdict: 'observed',
        source: 'pty-master',
        foregroundKind: shell.has(id) ? 'shell' : 'non-shell',
        processName: shell.has(id) ? 'zsh' : 'codex'
      }
    }),
    listProcesses: async () => Array.from(processes.values())
  })
  vi.spyOn(Date, 'now').mockImplementation(retentionNow)
  const service = createRuntimeAutomationService({ store, runtime, headless: false })
  service.setWebContents(
    Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, send: () => {} })
  )
  service.setRendererReady()
  const seed = await service.runNow(automation.id)
  const records = runtime.openedAgentSessionRecordStore()
  if (!seed.terminalPaneKey || !seed.terminalPtyId || !records) {
    throw new Error(`seed unavailable: ${seed.status}/${seed.error}`)
  }
  const pane = parsePaneKey(seed.terminalPaneKey)!
  seedTabId = pane.tabId
  const handle = runtime.getTerminalHandleForPaneKey(seed.terminalPaneKey)
  if (!handle) {
    throw new Error('seed handle unavailable')
  }
  await publishRenderer()
  const nativeExit = () => {
    shell.add(seed.terminalPtyId!)
    const row = normalizeCodexEvent(createHookListenerState(), 'Stop', '', seed.terminalPaneKey!, {
      session_id: 'retention',
      turn_id: 'seed'
    })!
    server.ingestTerminalStatus({
      ptyId: seed.terminalPtyId!,
      paneKey: seed.terminalPaneKey!,
      tabId: pane.tabId,
      worktreeId: automation.workspaceId!,
      terminalHandle: handle,
      payload: row
    })
  }
  const created = [seed]
  const createNewer = async () => {
    for (let n = 0; n < 3; n++) {
      store.updateAutomation(automation.id, { prompt: `New legitimate resource ${n}` })
      created.push(await service.runNow(automation.id))
      await publishRenderer()
      for (const id of processes.keys()) {
        shell.add(id)
      }
    }
  }
  return {
    store,
    runtime,
    service,
    records,
    seed,
    created,
    handle,
    pane,
    stops,
    processes,
    membership,
    nativeExit,
    createNewer,
    publishRenderer,
    persistRenderer,
    renderer: useAppStore,
    dispose: async () => {
      service.stop()
      rendererFixture.stopGraphSync()
      runtime.setNotifier(null)
      unsubscribe()
      rendererFixture.unsubscribeRenderer()
      for (const process of processes.values()) {
        runtime.onPtyExit(process.id, 0, process.incarnationId)
      }
      await Promise.all(exits)
      rendererFixture.restore()
      await stopStructuredAgentSessionRuntime()
      await closeTestStores()
      vi.restoreAllMocks()
    }
  }
}
