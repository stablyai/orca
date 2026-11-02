import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { runColdCrewCostProfiles } from '../../src/main/runtime/orchestration/crew/crew-recipient-delta-cost.test-fixture'
import { tmpdir } from 'node:os'
import * as profileStorage from '../../src/main/orca-profiles/profile-storage-paths'
import { randomUUID } from 'node:crypto'
import { RpcDispatcher } from '../../src/main/runtime/rpc/dispatcher'
import { ORCHESTRATION_METHODS } from '../../src/main/runtime/rpc/methods/orchestration'
import { TERMINAL_QUERY_METHODS } from '../../src/main/runtime/rpc/methods/terminal/terminal-query-methods'
import { JournalHostDatabase } from '../../src/main/native-chat/agent-session-journal/journal-host-database'
import { AgentSessionRecordStore } from '../../src/main/runtime/agent-session/records/agent-session-record-store'
import {
  peekOpenedAgentSessionRecordStore,
  releaseAgentSessionRecordStore
} from '../../src/main/runtime/agent-session/records/agent-session-record-store-slot'
import { testOrcaSessionId } from '../../src/shared/orca-session-address-test-fixture'
import '../../src/main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { dispatch } from '../../src/cli/dispatch'
import { RuntimeClient, RuntimeClientError } from '../../src/cli/runtime-client'
import { fingerprintAuthenticatedPairingCredential } from '../../src/main/runtime/device-principal'
import { syncFederatedDispatch } from '../../src/main/runtime/orchestration/federation-sync'
import { prepareFederatedAttachmentAuthority } from '../../src/main/runtime/rpc/methods/orchestration/federation/federation-attachment-authority'
import { readOrchestrationCompatibilityEvidence } from '../../src/shared/orchestration-compatibility-evidence'
import { ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION } from '../../src/shared/protocol-version'
import {
  createSessionCallerHarness,
  orchestrationRequest,
  ADDRESS_X,
  SESSION_X,
  WORKER_PANE
} from '../../src/main/runtime/rpc/orchestration-session-caller-test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../src/main/native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))
afterEach(async () => {
  const remaining = await releaseAgentSessionRecordStore()
  remaining?.journalDatabase.close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it('keeps imported and local peer authority through real CLI import, settlement, mailbox move, run-use and individual reply effects', async () => {
  const fixtureNow = 1_700_000_000_000
  const homeRef: { current: unknown } = { current: null }
  const workerRef: { current: unknown } = { current: null }
  const home = createSessionCallerHarness(homeRef)
  const worker = createSessionCallerHarness(workerRef)
  // Register test inventory through the production metadata writers; no PTY/process is launched.
  worker.runtime.registerPty('pty_f9_private', 'folder-worker-host', null, {
    tabId: 'tab_worker',
    leafId: '77777777-7777-4777-8777-777777777777'
  })
  worker.runtime.attachWindow(1)
  worker.runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab_worker',
        worktreeId: 'folder-worker-host',
        title: 'Worker',
        activeLeafId: '77777777-7777-4777-8777-777777777777',
        layout: null
      }
    ],
    leaves: [
      {
        tabId: 'tab_worker',
        worktreeId: 'folder-worker-host',
        leafId: '77777777-7777-4777-8777-777777777777',
        paneRuntimeId: 1,
        ptyId: 'pty_f9_private'
      }
    ]
  })
  const WORKER_HANDLE = worker.runtime.getTerminalHandleForPaneKey(WORKER_PANE)
  if (!WORKER_HANDLE) {
    throw new Error('Production terminal inventory did not mint a worker handle')
  }
  const workerDispatcher = new RpcDispatcher({
    runtime: worker.runtime,
    methods: [...ORCHESTRATION_METHODS, ...TERMINAL_QUERY_METHODS]
  })
  const mail = (h: typeof home) => h.db.db.prepare('SELECT * FROM messages ORDER BY sequence').all()
  const relay = (h: typeof home) =>
    h.db.db.prepare('SELECT * FROM federation_relay_items ORDER BY direction, sequence').all()
  const directory = mkdtempSync(join(tmpdir(), 'orca-pr34890-real-command-'))
  vi.spyOn(profileStorage, 'getProfileUserDataPath').mockReturnValue(directory)
  const homeJournal = JournalHostDatabase.open(join(directory, 'home-journal'))
  const homeStore = AgentSessionRecordStore.open({
    journalDatabase: homeJournal,
    hostId: 'local',
    legacySessionTabIds: []
  })
  const localStore = await worker.runtime.openAgentSessionRecordStore()
  const localId = testOrcaSessionId(randomUUID())
  const localAddress = `orca_session_id:${localId}`
  homeRef.current = { deps: { store: homeStore } }
  workerRef.current = {
    deps: { store: localStore },
    getPersistedVisibleSessionTabIndex: localStore.getVisibleSessionTabIndex
  }
  const foundNative = async (store: AgentSessionRecordStore, sessionId: string, tabId: string) => {
    const result = await store.founding.commit({
      sessionId,
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'folder-worker-host',
        workspaceKind: 'folder'
      },
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/unused-private-fixture-account-home' },
      surfaceTabId: tabId,
      expectedFence: null,
      spawnToken: 'unused-at-rest',
      claimKeyId: 'private-witness-claim',
      handoffOperationId: null,
      probe: { outcome: 'indeterminate', reason: 'at-rest creation starts no process' },
      operation: {
        callerKey: 'private-witness',
        operationId: `${fixtureNow}-${randomUUID().replaceAll('-', '')}`,
        fingerprint: `found:${sessionId}`
      },
      now: fixtureNow
    })
    return {
      result,
      persisted: store.getRecord(sessionId),
      visible: store.getVisibleSessionTabIndex()
    }
  }
  let pendingCheck: Promise<unknown> | undefined
  let pendingDone: Promise<unknown> | undefined
  try {
    await foundNative(homeStore, SESSION_X, 'tab_home_native')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const homeNudge = vi
      .spyOn(home.runtime, 'ensureOrchestrationFederationRelay')
      .mockImplementation(() => {})
    const workerRelayNudge = vi
      .spyOn(worker.runtime, 'ensureOrchestrationFederationRelay')
      .mockImplementation(() => {})
    vi.spyOn(home.runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})
    const workerDelivery = vi
      .spyOn(worker.runtime, 'deliverPendingMessagesForHandle')
      .mockImplementation(() => {})
    const workerNotify = vi.spyOn(worker.runtime, 'notifyMessageArrived')
    worker.records.clear()
    const panes = new Map([
      [WORKER_HANDLE, WORKER_PANE],
      ['term_peer', 'tab_peer:cccccccc-cccc-4ccc-8ccc-cccccccccccc']
    ])
    vi.spyOn(worker.runtime, 'getTerminalPaneKey').mockImplementation(
      (handle) => panes.get(handle) ?? null
    )
    vi.spyOn(worker.runtime, 'getLiveTerminalPaneKey').mockImplementation(
      (handle) => panes.get(handle) ?? null
    )
    vi.spyOn(worker.runtime, 'getPaneKeyForTerminalHandle').mockImplementation(
      (handle) => panes.get(handle) ?? null
    )
    vi.spyOn(worker.runtime, 'getTerminalHandleForPaneKey').mockImplementation(
      (pane) => [...panes].find(([, key]) => key === pane)?.[0] ?? null
    )
    vi.spyOn(worker.runtime, 'getTerminalWorktreeIdForHandle').mockImplementation((handle) =>
      panes.has(handle) ? 'folder-worker-host' : null
    )
    vi.spyOn(worker.runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      panes.has(handle) ? `worker-host:${handle}:1` : null
    )
    vi.spyOn(worker.runtime, 'getOrchestrationDispatchAuthority').mockReturnValue(null)
    vi.spyOn(worker.runtime, 'getOrchestrationFleetAgentStatusSnapshot').mockReturnValue([])
    await foundNative(localStore, localId, 'tab_local_native')

    const makeClient = (h: typeof home, ref: typeof homeRef, sessionId?: string) => {
      const client = new RuntimeClient('/tmp/imported-home-address-witness', 1000, null, null)
      vi.spyOn(client, 'call').mockImplementation(async (method: string, params: unknown) => {
        hostRef.current = ref.current
        const request = orchestrationRequest(
          method,
          z.record(z.string(), z.unknown()).parse(params),
          {
            sessionId,
            evidence: readOrchestrationCompatibilityEvidence({
              ORCA_TERMINAL_HANDLE: process.env.ORCA_TERMINAL_HANDLE,
              ORCA_PANE_KEY: process.env.ORCA_PANE_KEY
            })
          }
        )
        const response = await (h === worker
          ? workerDispatcher.dispatch(request)
          : h.dispatch(request))

        if (!response.ok) {
          throw new RuntimeClientError(response.error.code, response.error.message)
        }
        return {
          ...response,
          result: response.result,
          _meta: { runtimeId: h.runtime.getRuntimeId() }
        }
      })
      return client
    }
    const homeClient = makeClient(home, homeRef, SESSION_X)
    const workerClient = makeClient(worker, workerRef)
    const send = (client: RuntimeClient, to: string, subject: string) =>
      dispatch(['orchestration', 'send'], {
        client,
        flags: new Map([
          ['to', to],
          ['subject', subject],
          ['body', 'hello']
        ]),
        cwd: '/tmp',
        json: true
      })
    const command = (client: RuntimeClient, name: string, entries: [string, string | boolean][]) =>
      dispatch(['orchestration', name], {
        client,
        flags: new Map(entries),
        cwd: '/tmp',
        json: true
      })
    const workerIdentity = () => {
      vi.stubEnv('ORCA_AGENT_SESSION_ID', '')
      vi.stubEnv('ORCA_TERMINAL_HANDLE', WORKER_HANDLE)
      vi.stubEnv('ORCA_PANE_KEY', WORKER_PANE)
    }
    const effects = () =>
      structuredClone({
        homeMail: mail(home),
        workerMail: mail(worker),
        homeRelay: relay(home),
        workerRelay: relay(worker),
        homeNudge: homeNudge.mock.calls,
        workerRelayNudge: workerRelayNudge.mock.calls,
        workerNotify: workerNotify.mock.calls,
        workerDelivery: workerDelivery.mock.calls
      })
    vi.stubEnv('ORCA_AGENT_SESSION_ID', '')
    vi.stubEnv('ORCA_TERMINAL_HANDLE', WORKER_HANDLE)
    vi.stubEnv('ORCA_PANE_KEY', WORKER_PANE)
    await send(workerClient, 'term_peer', 'Unattached same-host control')
    expect(mail(worker)).toEqual([
      expect.objectContaining({ from_handle: WORKER_HANDLE, to_handle: 'term_peer' })
    ])
    const run = home.db.createRun({
      objective: 'Imported sender witness',
      coordinatorHandle: 'term_home_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    const homeFingerprint = fingerprintAuthenticatedPairingCredential('fake-home-pairing-token')
    const workerFingerprint = fingerprintAuthenticatedPairingCredential('fake-worker-pairing-token')
    const d = home.db.createStartingWorkerDispatch({
      taskSpec: 'Worker',
      taskRunId: run.id,
      creator: { kind: 'system' },
      maxDepth: 10,
      startOptions: { agent: 'codex' },
      federation: {
        environmentId: 'worker-env',
        environmentName: 'Worker host',
        peerFingerprint: workerFingerprint,
        protocolVersion: ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION
      }
    })
    home.db.prepareStartingWorkerAuthority({
      dispatchId: d.dispatch.id,
      handle: WORKER_HANDLE,
      paneKey: WORKER_PANE,
      processIncarnation: `worker-host:${WORKER_HANDLE}:1`,
      worktreeId: 'folder-worker-host',
      effects: [],
      setupState: 'not_applicable'
    })
    home.db.markWorkerDispatchReady(d.dispatch.id)
    worker.db.createRemoteDispatchAttachment({
      runId: run.id,
      dispatchId: d.dispatch.id,
      taskId: d.task.id,
      homePeerFingerprint: homeFingerprint,
      protocolVersion: ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION,
      runtimeEpoch: worker.runtime.getRuntimeId(),
      mutationReceipt: {
        callerFingerprint: homeFingerprint,
        requestId: 'attach-imported-home-witness',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'imported-home-witness-payload'
      }
    })
    prepareFederatedAttachmentAuthority({
      runtime: worker.runtime,
      db: worker.db,
      dispatchId: d.dispatch.id,
      terminalHandle: WORKER_HANDLE,
      worktreeId: 'folder-worker-host',
      setup: {
        requested: 'not_applicable',
        effective: 'not_applicable',
        source: 'existing_worktree',
        hookFound: false,
        startupPolicy: 'start-immediately',
        state: 'not_applicable'
      },
      effects: [],
      reusesTerminal: true
    })
    worker.db.markRemoteAttachmentReady(d.dispatch.id)
    const current = worker.db.isRemoteAttachmentProcessCurrent({
      dispatchId: d.dispatch.id,
      paneKey: WORKER_PANE,
      processIncarnation: `worker-host:${WORKER_HANDLE}:1`
    })
    expect(current).toBe(true)
    expect(run.coordinator_handle).not.toBe(ADDRESS_X)
    expect(localStore.getRecord(SESSION_X)).toBe(null)
    expect(home.db.getWorkerDispatch(d.dispatch.id)?.state).toBe('ready')

    vi.stubEnv('ORCA_AGENT_SESSION_ID', SESSION_X)
    vi.stubEnv('ORCA_TERMINAL_HANDLE', '')
    vi.stubEnv('ORCA_PANE_KEY', '')
    await send(homeClient, `dispatch:${d.dispatch.id}`, 'Fresh distinct home sender')
    const queued = home.db.listPendingFederationRelay(d.dispatch.id, 'to_worker')
    expect(queued).toHaveLength(1)
    expect(JSON.parse(queued[0].payload)).toMatchObject({ from: ADDRESS_X, type: 'status' })

    vi.spyOn(home.runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'worker-env',
      name: 'Worker host',
      peerFingerprint: workerFingerprint,
      pairingRevision: 1
    })
    vi.spyOn(home.runtime, 'callOrchestrationWorkerServer').mockImplementation(
      async (_selector, method, params, _timeout, envelope, _options) => {
        hostRef.current = workerRef.current
        if (method === 'status.get') {
          const status = worker.runtime.getStatus()

          return status
        }
        const response = await worker.dispatcher.dispatch(
          orchestrationRequest(method, z.record(z.string(), z.unknown()).parse(params), {
            requestId: envelope?.orchestrationRequestId
          }),
          { authenticatedCallerFingerprint: homeFingerprint }
        )

        if (!response.ok) {
          throw new RuntimeClientError(response.error.code, response.error.message)
        }
        return response.result
      }
    )
    await syncFederatedDispatch(home.runtime, d.dispatch.id)
    expect(home.db.listPendingFederationRelay(d.dispatch.id, 'to_worker')).toEqual([])
    expect(worker.db.getRemoteDispatchAttachment(d.dispatch.id)?.to_worker_imported_sequence).toBe(
      1
    )
    const imported = mail(worker)
    expect(imported).toEqual([
      expect.anything(),
      expect.objectContaining({
        from_handle: ADDRESS_X,
        to_handle: `dispatch:${d.dispatch.id}`,
        subject: 'Fresh distinct home sender',
        delivered_at: null
      })
    ])
    hostRef.current = workerRef.current
    const crew = worker.runtime.getOrchestrationCrewSnapshot(WORKER_HANDLE)
    expect(crew.sections.talkingWith.every((row) => !row.sendAddress)).toBe(true)

    workerIdentity()
    const checkpoint = new Promise<void>((resolve) => {
      const wait = worker.runtime.waitForMessage.bind(worker.runtime)
      vi.spyOn(worker.runtime, 'waitForMessage').mockImplementation((...args) => {
        const pending = wait(...args)

        resolve()
        return pending
      })
    })
    // A nonmatching real read leaves the status unread. Its real timeout revalidates ownership.
    pendingCheck = command(workerClient, 'check', [
      ['peek', true],
      ['wait', true],
      ['types', 'escalation'],
      ['timeout-ms', '1500']
    ]).then(
      () => ({ ok: true }),
      (error: unknown) => ({
        ok: false,
        error:
          error instanceof RuntimeClientError
            ? { code: error.code, message: error.message }
            : String(error)
      })
    )
    await checkpoint

    const reportQueued = new Promise<void>((resolve) => {
      const enqueue = worker.db.enqueueFederationRelay.bind(worker.db)
      vi.spyOn(worker.db, 'enqueueFederationRelay').mockImplementation((params) => {
        const row = enqueue(params)
        if (params.kind === 'worker_done') {
          resolve()
        }
        return row
      })
    })
    pendingDone = command(workerClient, 'send', [
      ['subject', 'Finite attachment settlement'],
      ['body', 'completed'],
      ['type', 'worker_done'],
      ['outcome', 'succeeded'],
      ['task-id', d.task.id],
      ['dispatch-id', d.dispatch.id]
    ]).then(
      () => ({ ok: true }),
      (error: unknown) => ({
        ok: false,
        error:
          error instanceof RuntimeClientError
            ? { code: error.code, message: error.message }
            : String(error)
      })
    )
    await reportQueued
    await syncFederatedDispatch(home.runtime, d.dispatch.id)
    const doneResult = await pendingDone

    const checkResult = await pendingCheck

    expect(doneResult).toEqual({ ok: true })
    expect(worker.db.getRemoteDispatchAttachment(d.dispatch.id)?.state).toBe('succeeded')
    expect(checkResult).toMatchObject({ ok: false, error: { code: 'dispatch_inactive' } })
    await command(workerClient, 'run-use', [['id', run.id]])

    expect(localStore.getRecord(SESSION_X)).toBe(null)
    expect(
      worker.db.getCurrentRunForCoordinator({
        orcaSessionId: localId,
        terminalHandle: null,
        paneKey: null
      })
    ).toBeUndefined()
    // Host-install seam: its normal restart owner reconciles the reopened at-rest record before a command acts.
    await localStore.reconcileOnRestart({
      sessionId: localId,
      probe: async () => ({ outcome: 'pid-absent' }),
      now: fixtureNow + 1_000
    })
    expect(localStore.getRecord(localId)?.lease.unreconciled).toBe(false)
    const localClient = makeClient(worker, workerRef, localId)
    vi.stubEnv('ORCA_AGENT_SESSION_ID', localId)
    vi.stubEnv('ORCA_TERMINAL_HANDLE', '')
    vi.stubEnv('ORCA_PANE_KEY', '')
    await send(localClient, WORKER_HANDLE, 'Ordinary local native no explicit Run')

    workerIdentity()
    hostRef.current = workerRef.current
    expect(peekOpenedAgentSessionRecordStore()).toBe(localStore)
    const detachedCrew = worker.runtime.getOrchestrationCrewSnapshot(WORKER_HANDLE)

    const homePeer = detachedCrew.sections.talkingWith.find((row) =>
      row.partyKey.endsWith(`${ADDRESS_X}"]`)
    )
    const localPeer = detachedCrew.sections.talkingWith.find(
      (row) => row.sendAddress === localAddress
    )
    expect(homePeer).toMatchObject({ latest: { preview: 'hello' } })
    expect(homePeer).not.toHaveProperty('sendAddress')
    if (!homePeer || !localPeer?.sendAddress) {
      throw new Error('Target rows or actual local address missing')
    }
    for (const [peer, to] of [
      [homePeer, ADDRESS_X],
      [localPeer, localPeer.sendAddress]
    ] as const) {
      const before = effects()
      let result: unknown
      try {
        await send(workerClient, to, 'Exact detached returned individual reply')
        result = { ok: true }
      } catch (error) {
        result = {
          ok: false,
          error:
            error instanceof RuntimeClientError
              ? { code: error.code, message: error.message }
              : String(error)
        }
      }

      if (peer === homePeer) {
        expect(result).toMatchObject({ ok: false, error: { code: 'session_caller_unknown' } })
        expect(effects()).toEqual(before)
      } else {
        expect(result).toEqual({ ok: true })
      }
    }
    // In-process CLI/RPC and real owners; inventory, transport and delivery tails remain seams.
    const movedHome = worker.db.db
      .prepare('SELECT * FROM messages WHERE from_handle = ?')
      .get(ADDRESS_X)
    const localMessage = worker.db.db
      .prepare('SELECT * FROM messages WHERE from_handle = ?')
      .get(localAddress)
    expect(movedHome).toMatchObject({
      id: expect.stringMatching(/^relay_[a-f0-9]{12}$/),
      run_id: run.id,
      to_handle: `run:${run.id}`,
      sender_pane_key: null,
      read: 0
    })
    expect(localMessage).toMatchObject({
      id: expect.stringMatching(/^msg_[a-f0-9]{12}$/),
      run_id: run.id,
      to_handle: `run:${run.id}`,
      sender_pane_key: null
    })
    expect(relay(worker)).toEqual([
      expect.objectContaining({
        direction: 'to_home',
        kind: 'worker_done',
        acked_at: expect.any(String)
      })
    ])
    expect(
      worker.db.db
        .prepare(
          "SELECT * FROM messages WHERE subject = 'Exact detached returned individual reply'"
        )
        .all()
    ).toEqual([
      expect.objectContaining({
        from_handle: WORKER_HANDLE,
        to_handle: localAddress,
        sender_pane_key: WORKER_PANE
      })
    ])
  } finally {
    if (pendingCheck) {
      await pendingCheck
    }
    if (pendingDone) {
      await pendingDone
    }
    homeJournal.close()
    const released = await releaseAgentSessionRecordStore()
    released?.journalDatabase.close()
    home.close()
    worker.close()
    hostRef.current = null
  }
})

it('loads saved sessions once at N and 10N through the real process slot and first completed Crew frame', async () => {
  await runColdCrewCostProfiles(() => {
    hostRef.current = null
  })
})
