import {
  ChatOpenTestRuntime,
  exerciseRecordedChatOpen,
  type createChatRendererBridge
} from './automation-chat-renderer-test-harness'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi, type Mock } from 'vitest'
import type { OrcaRuntimeService } from '../../../src/main/runtime/orca-runtime'
import type { StructuredAgentSessionHost } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-host'
import { createRuntimeAutomationService } from '../../../src/main/automations/runtime-automation-service'
import { createAutomationRunWriter } from '../../../src/main/automations/automation-run-writer'
import type { AutomationChatLaunchRequest } from '../../../src/main/automations/automation-chat-agent-launch'
import { automationRunOperationId } from '../../../src/main/automations/automation-run-operation'
import { agentJournalItemKey } from '../../../src/shared/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../src/shared/agent-session-journal-types'
import {
  HOST_TEST_NOW,
  HOST_TEST_THREAD,
  HOST_TEST_LOCATION
} from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually
} from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import {
  createStore,
  closeTestStores,
  testState,
  readPersistedStateJson
} from '../../../src/main/persistence/persistence-test-harness'

export type ChatReuseMode = 'normal' | 'lost-reply' | 'restart'

export async function exerciseBusyChatReuse(
  mode: ChatReuseMode,
  automation: AutomationChatLaunchRequest['automation'],
  target: AutomationChatLaunchRequest['target'],
  controls: {
    setHost: (host: StructuredAgentSessionHost | null) => void
    bindRenderer: (renderer: Awaited<ReturnType<typeof createChatRendererBridge>> | null) => void
    launch: Mock
  }
): Promise<void> {
  const sessionId = 'codex_automation_reuse'
  vi.spyOn(Date, 'now').mockReturnValue(HOST_TEST_NOW)
  const rig = await createQueuedMessageTestRig({ restartable: true, sessionId })
  controls.setHost(rig.host)
  const root = mkdtempSync(join(tmpdir(), 'orca-34332-accepted-'))
  testState.dir = root
  const disk = createStore()
  let service: ReturnType<typeof createRuntimeAutomationService> | undefined
  const intervals = vi.spyOn(globalThis, 'setInterval')
  const cleared = vi.spyOn(globalThis, 'clearInterval')
  try {
    const working = await rig.workingSend()
    disk.addRepo(target.repo)
    const saved = disk.createAutomation({
      ...automation,
      agentId: 'codex',
      workspaceId: HOST_TEST_LOCATION.workspaceId,
      launchSetupPatch: { surface: 'chat' },
      reuseSession: true,
      enabled: false,
      projectId: target.repo.id
    })
    expect(saved.surface).toBe('chat')
    const writer = createAutomationRunWriter(disk, null)
    const first = await writer.createRun(saved, Date.now() - 2, 'manual')
    const firstResult = await writer.updateRun({
      runId: first.id,
      status: 'completed',
      sessionKind: 'chat',
      chatSessionId: sessionId,
      workspaceId: saved.workspaceId,
      outputSnapshot: {
        format: 'plain_text',
        content: 'Prior automation output',
        truncated: false,
        capturedAt: Date.now()
      }
    })
    expect(firstResult.outputSnapshot).toEqual({
      format: 'plain_text',
      content: 'Prior automation output',
      truncated: false,
      capturedAt: HOST_TEST_NOW
    })
    const previous = await writer.createRun(saved, Date.now() - 1, 'manual')
    await writer.updateRun({
      runId: previous.id,
      status: 'dispatch_failed',
      sessionKind: 'chat',
      chatSessionId: sessionId,
      workspaceId: saved.workspaceId
    })
    const current = await writer.createRun(saved, Date.now(), 'manual')
    const sent = rig.host.send.bind(rig.host)
    const send = vi.spyOn(rig.host, 'send').mockImplementationOnce(async (...args) => {
      const answer = await sent(...args)
      expect(answer).toMatchObject({ ok: true, value: { queued: { state: 'waiting' } } })
      if (mode === 'lost-reply') {
        throw new Error('accepted reply lost')
      }
      return answer
    })
    const runtimeFacade = {
      ensureStructuredAgentSessionHost: async () => {},
      openAgentSessionRecordStore: async () => rig.store,
      openedAgentSessionRecordStore: () => rig.store,
      setAutomationService: vi.fn(),
      notifyAutomationsChanged: vi.fn(),
      showManagedWorktree: async () => {
        throw new Error('optional display unavailable')
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the runtime facade is scripted; the real host/store and service/send/receipt/queue/observer/writer execute.
    const runtime = runtimeFacade as unknown as OrcaRuntimeService
    service = createRuntimeAutomationService({ store: disk, runtime, headless: true })
    const dispatched = await service.runNow(saved.id)
    expect(dispatched).toMatchObject({
      status: 'dispatched',
      sessionKind: 'chat',
      chatSessionId: sessionId
    })
    const q = automationRunOperationId(current, 'reuse-send')
    expect(await rig.drafts()).toEqual([{ messageId: q, state: 'waiting' }])
    expect(await rig.handoff(q)).toBeUndefined()
    expect(send).toHaveBeenCalledOnce()
    service.start()
    await eventually(() =>
      expect(rig.host.collaboratorsForTests().sessions['observers'].size).toBe(1)
    )
    if (mode === 'restart') {
      service.stop()
      expect(rig.host.collaboratorsForTests().sessions['observers'].size).toBe(0)
      // The crash's durable row predates saving the accepted Chat identity; Q's receipt survives.
      await writer.updateRun({
        runId: current.id,
        status: 'dispatching',
        sessionKind: 'terminal',
        chatSessionId: null
      })
      await rig.restartHostProcess()
      controls.setHost(rig.host)
      service = createRuntimeAutomationService({ store: disk, runtime, headless: true })
      service.start()
      await eventually(() =>
        expect(disk.listAutomationRuns(saved.id).find((r) => r.id === current.id)).toMatchObject({
          status: 'dispatched',
          chatSessionId: sessionId
        })
      )
      expect(await rig.drafts()).toEqual([{ messageId: q, state: 'waiting' }])
      expect(await rig.handoff(q)).toBeUndefined()
      expect(await rig.queuePause()).toBeNull()
      expect(await rig.sendNow(q)).toMatchObject({
        ok: true,
        value: { submission: expect.anything() }
      })
    } else {
      await rig.settleAccepted(working, 'human')
      const sink = rig.providerEvents()
      sink.appendItem(
        { provider: 'codex', threadId: HOST_TEST_THREAD, turnId: 'turn-human', ordinal: 1 },
        { kind: 'turn', turnId: 'turn-human', state: 'completed', outcome: 'success' },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE, lifecycle: true }
      )
      sink.publish({ lifecycle: true })
      expect(await sink.written?.()).toEqual({ ok: true })
      await rig.host.flushStreamedEvents(sessionId)
    }
    const readCurrent = () => disk.listAutomationRuns(saved.id).find((r) => r.id === current.id)!
    expect(readCurrent().status).toBe('dispatched')
    await eventually(async () => expect(await rig.handoff(q)).toBeDefined())
    const submission = await rig.handoffId(q)
    expect(submission).not.toBe(q)
    await eventually(async () =>
      expect((await rig.submission(submission))?.handedOverAt).toBeDefined()
    )
    await rig.settleAccepted(submission, 'automation')
    const accepted = await rig.submission(submission)
    const sink = rig.providerEvents()
    const ownId = {
      provider: 'codex' as const,
      threadId: HOST_TEST_THREAD,
      turnId: 'turn-automation',
      ordinal: 1
    }
    sink.appendItem(
      ownId,
      {
        kind: 'turn',
        turnId: 'turn-automation',
        userItemId: accepted!.providerItemId!,
        state: 'completed',
        outcome: 'success'
      },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE, lifecycle: true }
    )
    sink.appendItem(
      { ...ownId, ordinal: 2 },
      {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Exact automation output' }]
      },
      { turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(ownId) } }
    )
    sink.appendItem(
      { ...ownId, turnId: 'human-other', ordinal: 3 },
      {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Unrelated human output' }]
      },
      { turnScope: { kind: 'turn', turnItemId: 'human-root' } }
    )
    sink.publish({ lifecycle: true })
    expect(await sink.written?.()).toEqual({ ok: true })
    await rig.host.flushStreamedEvents(sessionId)
    await eventually(() =>
      expect(readCurrent()).toMatchObject({
        status: 'completed',
        chatSessionId: sessionId,
        outputSnapshot: { content: 'Exact automation output' }
      })
    )
    expect(disk.listAutomationRuns(saved.id).find((r) => r.id === first.id)).toEqual(firstResult)
    expect(disk.listAutomationRuns(saved.id)).toHaveLength(3)
    const persisted = JSON.parse(readPersistedStateJson(join(root, 'orca-data.json')))
    expect(
      persisted.automationRuns.find((row: { id: string }) => row.id === current.id)
    ).toMatchObject({
      chatSessionId: sessionId,
      status: 'completed',
      outputSnapshot: { content: 'Exact automation output' }
    })
    await eventually(() => expect(readCurrent().usage).not.toBeNull())
    const beforeOpen = {
      journal: await rig.host.journalSnapshot(sessionId),
      runs: disk.listAutomationRuns(saved.id),
      record: rig.store.getConversation(sessionId)
    }
    const create = vi.spyOn(rig.host, 'create')
    const openingRuntime = new ChatOpenTestRuntime(disk)
    vi.spyOn(openingRuntime, 'ensureStructuredAgentSessionHost').mockResolvedValue()
    vi.spyOn(openingRuntime, 'openAgentSessionRecordStore').mockResolvedValue(rig.store)
    await exerciseRecordedChatOpen(openingRuntime, readCurrent(), controls.bindRenderer)
    expect(rig.host.isSessionTabVisible(sessionId)).toBe(true)
    expect(await rig.host.journalSnapshot(sessionId)).toEqual(beforeOpen.journal)
    expect(disk.listAutomationRuns(saved.id)).toEqual(beforeOpen.runs)
    expect(rig.store.getConversation(sessionId)).toEqual(beforeOpen.record)
    expect(create).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledOnce()
    expect(controls.launch).not.toHaveBeenCalled()
    service.stop()
    expect(rig.host.collaboratorsForTests().sessions['observers'].size).toBe(0)
  } finally {
    service?.stop()
    controls.setHost(null)
    await rig.dispose()
    await closeTestStores()
    rmSync(root, { recursive: true, force: true })
    for (const interval of intervals.mock.results) {
      expect(cleared.mock.calls.some(([timer]) => timer === interval.value)).toBe(true)
    }
  }
}
