import type { RuntimeStore } from '../../src/main/runtime/runtime-store-contract'
import type { RuntimeClientEvent } from '../../src/shared/runtime-client-events'
import '../../src/main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ORCHESTRATION_CREW_METHODS } from '../../src/main/runtime/rpc/methods/orchestration/crew-methods'
import { formatOrcaSessionAddress } from '../../src/shared/orca-session-address'
import { RPC_PARAMS_BY_METHOD } from '../../src/shared/rpc-contract/rpc-params-catalog.generated'
import { ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION } from '../../src/shared/protocol-version'
import { dispatch } from '../../src/cli/dispatch'
import { RuntimeClient, RuntimeClientError } from '../../src/cli/runtime-client'
import { buildCrewSnapshot } from '../../src/main/runtime/orchestration/crew/crew-read-model'
import { agentSessionConversationView } from '../../src/shared/agent-session-conversation-view'
import {
  createSessionCallerHarness,
  orchestrationRequest,
  sessionRecord,
  SESSION_X,
  SESSION_Y,
  WORKER_HANDLE,
  WORKER_PANE
} from '../../src/main/runtime/rpc/orchestration-session-caller-test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../src/main/native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it('executes snapshot addresses through CLI send and the dispatcher into the proven mailbox', async () => {
  const params = ORCHESTRATION_CREW_METHODS[0].params
  expect(params).toBe(RPC_PARAMS_BY_METHOD['orchestration.crewSubscribe'])
  for (const party of [
    'term_worker',
    'dispatch:ctx_worker',
    'run:run_home',
    formatOrcaSessionAddress(SESSION_X)
  ]) {
    expect(params.parse({ party, ignored: true })).toEqual({ party })
  }
  for (const party of ['term worker', 'dispatch:', 'task:task_worker', 'not an address']) {
    expect(params.safeParse({ party }).success).toBe(false)
  }
  const h = createSessionCallerHarness(hostRef)
  try {
    vi.stubEnv('ORCA_AGENT_SESSION_ID', '')
    vi.stubEnv('ORCA_PANE_KEY', '')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(h.runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})
    vi.spyOn(h.runtime, 'ensureOrchestrationFederationRelay').mockImplementation(() => {})
    vi.spyOn(h.runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_peer'
        ? 'tab_peer:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
        : handle === 'term_coord'
          ? 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
          : handle === WORKER_HANDLE
            ? WORKER_PANE
            : null
    )
    vi.spyOn(h.runtime, 'getLiveTerminalPaneKey').mockImplementation((handle) =>
      h.runtime.getTerminalPaneKey(handle)
    )
    const run = h.db.createRun({
      objective: 'Crew',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    const worker = h.db.createDispatchContext({
      taskId: h.db.createTask({ runId: run.id, spec: 'Worker' }).id,
      assigneeHandle: WORKER_HANDLE,
      assigneePaneKey: WORKER_PANE,
      creator: { kind: 'system' },
      maxDepth: 10
    })
    const federated = h.db.createStartingWorkerDispatch({
      taskSpec: 'Federated worker',
      taskRunId: run.id,
      creator: { kind: 'system' },
      maxDepth: 10,
      startOptions: { agent: 'codex' },
      federation: {
        environmentId: 'other-host',
        environmentName: 'Windows',
        peerFingerprint: 'test-peer',
        protocolVersion: ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION
      }
    })
    h.db.prepareStartingWorkerAuthority({
      dispatchId: federated.dispatch.id,
      handle: 'term_remote',
      paneKey: 'tab_remote:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      processIncarnation: 'runtime:remote:1',
      worktreeId: 'folder-remote',
      effects: [],
      setupState: 'not_applicable'
    })
    h.db.markWorkerDispatchReady(federated.dispatch.id)
    h.db.insertMessage({ from: 'term_peer', to: 'term_coord', subject: 'Hello', body: 'hello' })
    const x = sessionRecord(SESSION_X)
    h.records.set(SESSION_X, {
      ...x,
      conversationCommand: {
        command: 'clear',
        phase: 'committed',
        state: 'completed',
        callerKey: 'clear-key',
        operationId: 'clear-test',
        replacementSessionId: SESSION_Y
      }
    })
    h.records.set(SESSION_Y, sessionRecord(SESSION_Y))
    h.db.insertMessage({
      from: `orca_session_id:${SESSION_X}`,
      to: 'term_coord',
      subject: 'Chat',
      body: 'clear lineage'
    })
    const deps = {
      db: h.db,
      retainedDbExists: true,
      hostKey: 'local',
      statuses: [],
      records: {
        getRecord: (id: string) => {
          const record = h.records.get(id)
          return record ? agentSessionConversationView(record) : null
        },
        listRecords: () => [...h.records.values()].map(agentSessionConversationView)
      },
      liveHandle: (handle: string) => handle.startsWith('term_'),
      livePaneForHandle: (handle: string) => h.runtime.getLiveTerminalPaneKey(handle),
      paneForHandle: (handle: string) => (handle === WORKER_HANDLE ? WORKER_PANE : null),
      handleForPane: () => null,
      name: () => 'Duplicate name'
    }
    const crew = buildCrewSnapshot('term_coord', deps)
    const managed = buildCrewSnapshot(WORKER_HANDLE, deps)
    const addresses = [
      ...crew.sections.managing,
      ...crew.sections.talkingWith,
      ...managed.sections.managedBy
    ].flatMap((row) => (row.sendAddress ? [row.sendAddress] : []))
    expect(addresses).toEqual(
      expect.arrayContaining([
        `dispatch:${worker.id}`,
        `dispatch:${federated.dispatch.id}`,
        `run:${run.id}`,
        'term_peer',
        `orca_session_id:${SESSION_X}`
      ])
    )
    const client = new RuntimeClient('/tmp/crew-address-client', 1000, null, null)
    vi.spyOn(client, 'call').mockImplementation(async (method: string, params: unknown) => {
      const response = await h.dispatch(
        orchestrationRequest(method, z.record(z.string(), z.unknown()).parse(params))
      )
      if (!response.ok) {
        throw new RuntimeClientError(response.error.code, response.error.message)
      }
      return { ...response, result: response.result, _meta: { runtimeId: 'crew-test' } }
    })
    for (const to of addresses) {
      await dispatch(['orchestration', 'send'], {
        client,
        flags: new Map([
          ['from', WORKER_HANDLE],
          ['to', to],
          ['subject', 'Crew send'],
          ['body', to]
        ]),
        cwd: '/tmp',
        json: true
      })
    }
    const messages = h.db.db
      .prepare("SELECT to_handle, body FROM messages WHERE subject = 'Crew send' ORDER BY sequence")
      .all()
    expect(messages).toEqual(
      addresses
        .filter((address) => address !== `dispatch:${federated.dispatch.id}`)
        .map((address) => ({ to_handle: address, body: address }))
    )
    const relays = h.db.db
      .prepare(
        "SELECT dispatch_id, direction, payload FROM federation_relay_items WHERE kind = 'control_message'"
      )
      .all()
    expect(relays).toEqual([
      expect.objectContaining({
        dispatch_id: federated.dispatch.id,
        direction: 'to_worker',
        payload: expect.stringContaining(`dispatch:${federated.dispatch.id}`)
      })
    ])
  } finally {
    h.close()
  }
})

it('keeps crew as the only observer for title, settings and mirrored-name source changes', async () => {
  const { OrcaRuntimeService } = await import('../../src/main/runtime/orca-runtime')
  const { partialRuntimeStore } =
    await import('../../src/main/runtime/runtime-store-partial-fixture')
  const { getDefaultWorkspaceSession, getDefaultSettings } =
    await import('../../src/shared/constants')
  const { makeTerminalTab } =
    await import('../../src/main/persistence/persistence-session-fixtures')
  const settingsListeners = new Set<Parameters<NonNullable<RuntimeStore['onSettingsChanged']>>[0]>()
  const sessionListeners = new Set<
    Parameters<NonNullable<RuntimeStore['onWorkspaceSessionWritten']>>[0]
  >()
  const worktreeId = 'repo-1::/workspace'
  let session = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [worktreeId]: [
        makeTerminalTab({
          id: 'tab_worker',
          worktreeId,
          title: 'Initial worker',
          customTitle: 'Initial worker'
        })
      ]
    }
  }
  let generated = true
  const store = partialRuntimeStore({
    getSettings: () => ({ tabAutoGenerateTitle: generated }),
    getWorkspaceSession: () => session,
    getWorkspaceSessionHostIds: () => ['local'],
    onSettingsChanged: (listener) => {
      settingsListeners.add(listener)
      return () => settingsListeners.delete(listener)
    },
    onWorkspaceSessionWritten: (listener) => {
      sessionListeners.add(listener)
      return () => sessionListeners.delete(listener)
    }
  })
  class CrewNameRuntime extends OrcaRuntimeService {
    publishClientEvent(event: RuntimeClientEvent): void {
      this.emitClientEvent(event)
    }
  }
  const runtime = new CrewNameRuntime(store)
  const { OrchestrationDb } = await import('../../src/main/runtime/orchestration/db')
  const { subscribeCrew } = await import('../../src/main/runtime/orchestration/crew/crew-stream')
  const db = new OrchestrationDb(':memory:')
  runtime.setOrchestrationDb(db)
  const workerPane = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const coordinatorPane = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  runtime.registerPty('pty_worker', worktreeId, null, {
    tabId: 'tab_worker',
    leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  })
  runtime.registerPty('pty_coord', worktreeId, null, {
    tabId: 'tab_coord',
    leafId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab_worker',
        worktreeId,
        title: 'Initial worker',
        activeLeafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        layout: null
      },
      {
        tabId: 'tab_coord',
        worktreeId,
        title: 'Coordinator',
        activeLeafId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        layout: null
      }
    ],
    leaves: [
      {
        tabId: 'tab_worker',
        worktreeId,
        leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        paneRuntimeId: 1,
        ptyId: 'pty_worker'
      },
      {
        tabId: 'tab_coord',
        worktreeId,
        leafId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        paneRuntimeId: 1,
        ptyId: 'pty_coord'
      }
    ]
  })
  const workerHandle = runtime.getTerminalHandleForPaneKey(workerPane)!
  const coordinatorHandle = runtime.getTerminalHandleForPaneKey(coordinatorPane)!
  const run = db.createRun({
    objective: 'Observed names',
    coordinatorHandle,
    coordinatorPaneKey: coordinatorPane
  })
  db.createDispatchContext({
    taskId: db.createTask({ runId: run.id, spec: 'Worker' }).id,
    assigneeHandle: workerHandle,
    assigneePaneKey: workerPane,
    creator: { kind: 'system' },
    maxDepth: 10
  })
  const names = vi.spyOn(runtime.orchestrationSenderNames, 'captureCrewInputs')
  const selection = vi.spyOn(db, 'listSessionDispatchesForPresentation')
  const frames: unknown[] = []
  const stop = subscribeCrew(
    () => runtime.getOrchestrationCrewSnapshot(coordinatorHandle),
    runtime.watchOrchestrationCrew,
    (frame) => frames.push(frame)
  )
  try {
    expect(runtime.getOrchestrationCrewSnapshot(coordinatorHandle).sections.managing[0].label).toBe(
      'Initial worker'
    )
    selection.mockClear()
    names.mockClear()
    // RuntimeClientEventBus is the real production filter. Crew is its only enrolled consumer.
    runtime.publishClientEvent({
      type: 'terminalSideEffects',
      batch: { ptyId: 'pty', seq: 1, facts: [{ kind: 'bell' }] }
    })
    await Promise.resolve()
    expect(selection).not.toHaveBeenCalled()
    expect(names).not.toHaveBeenCalled()
    runtime.publishClientEvent({
      type: 'terminalSideEffects',
      batch: {
        ptyId: 'pty',
        seq: 2,
        facts: [{ kind: 'title', rawTitle: 'Working', normalizedTitle: 'Working' }]
      }
    })
    generated = false
    for (const listener of settingsListeners) {
      listener(
        { tabAutoGenerateTitle: false },
        { ...getDefaultSettings('/tmp'), tabAutoGenerateTitle: false }
      )
    }
    session = {
      ...session,
      tabsByWorktree: {
        [worktreeId]: [
          makeTerminalTab({
            id: 'tab_worker',
            worktreeId,
            title: 'Renamed tab',
            customTitle: 'Renamed tab'
          })
        ]
      }
    }
    for (const listener of sessionListeners) {
      listener('local')
    }
    await Promise.resolve()
    expect(selection).not.toHaveBeenCalled()
    expect(names).toHaveBeenCalledTimes(1)
    expect(runtime.getOrchestrationCrewSnapshot(coordinatorHandle).sections.managing[0].label).toBe(
      'Renamed tab'
    )
  } finally {
    stop()
    db.close()
  }
})
