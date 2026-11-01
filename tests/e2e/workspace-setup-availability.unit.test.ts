import { agentSessionConversationView } from '../../src/shared/agent-session-conversation-view'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../src/shared/agent-session-wire'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionRefusalError } from '../../src/shared/agent-session-wire-refusals'
import { foldAgentSessionStatusEvent } from '../../src/shared/agent-session-status-snapshot-fold'
import { setStructuredAgentSessionHost } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-registry'
import { recordStructuredAgentSessionHostInstallRefusal } from '../../src/main/runtime/structured-agent-session-host-refusal'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import { WorkspaceSetupAgentStartHolds } from '../../src/main/runtime/workspace-setup-agent-start-holds'
import {
  dispatcher,
  SESSION,
  hostStub,
  STRUCTURED_CLIENT
} from '../../src/main/runtime/rpc/methods/structured-agent-session-rpc.test-fixture'
import { STRUCTURED_AGENT_SESSION_STATUS_METHODS } from '../../src/main/runtime/rpc/methods/structured-agent-session-status-stream'

import { createTrackedJournalOpener } from '../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import type { Tab } from '../../src/shared/tab-types'
import { agentSessionRecordFixture } from '../../src/shared/agent-session-record.test-fixture'
import { structuredAgentSessionPaneKey } from '../../src/shared/structured-agent-session-projection'
import { createStructuredChatNamingHandler } from '../../src/main/native-chat/structured-chat-naming'
import { StructuredAgentSessionStatusFeed } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-status-feed'
import {
  getStructuredAgentSessionStatusFeed,
  resetStructuredAgentSessionStatusFeedsForTests
} from '../../src/renderer/src/runtime/structured-agent-session-status-feed'
import { getWorktreeIdsWithStructuredChat } from '../../src/renderer/src/components/sidebar/visible-worktree-activity-inputs'
import { hasSleepableWorkspaceActivity } from '../../src/renderer/src/components/sidebar/workspace-lineage-menu-actions'
import { buildDesktopWorkspaceRowFactReader } from '../../src/renderer/src/components/sidebar/desktop-workspace-row-facts'
import {
  filterWorkspaceRows,
  NO_WORKSPACE_ROW_FILTERS
} from '../../src/shared/workspace-view/workspace-row-filters'
import { makeWorktree } from '../../src/renderer/src/components/sidebar/worktree-list-lineage-card-test-fixtures'

const legacyTransport = vi.hoisted(() => ({ subscribe: vi.fn() }))
vi.mock('../../src/renderer/src/runtime/structured-agent-session-client', () => ({
  subscribeStructuredAgentSessionStatus: legacyTransport.subscribe
}))
vi.mock('../../src/renderer/src/runtime/runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: vi.fn(async () => true)
}))

const connections: AbortController[] = []
const journals = createTrackedJournalOpener()
const journalRoots: string[] = []
afterEach(async () => {
  await journals.closeAll()
  await Promise.all(
    journalRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
  for (const controller of connections.splice(0)) {
    controller.abort()
  }
  resetStructuredAgentSessionStatusFeedsForTests()
  vi.clearAllMocks()
  setStructuredAgentSessionHost(null)
  recordStructuredAgentSessionHostInstallRefusal(null)
  vi.useRealTimers()
})

function open(
  runtime: OrcaRuntimeService,
  restore: () => Promise<void> = async () => {},
  onResult: (value: AgentSessionStatusEvent) => void = () => {},
  client = STRUCTURED_CLIENT
) {
  const controller = new AbortController()
  connections.push(controller)
  const replies: unknown[] = []
  const results: unknown[] = []
  const pending = dispatcher(
    {
      workspaceSetupAgentStarts: runtime.workspaceSetupAgentStarts,
      registerOwnedSubscriptionCleanup: runtime.registerOwnedSubscriptionCleanup.bind(runtime),
      restoreStructuredAgentSessionTabs: restore
    },
    STRUCTURED_AGENT_SESSION_STATUS_METHODS
  ).dispatchStreaming(
    { id: 'setup', authToken: 'token', method: 'agentSession.subscribeStatus', params: null },
    (raw) => {
      const reply: { result?: AgentSessionStatusEvent } = JSON.parse(raw)
      replies.push(reply)
      if (reply.result !== undefined) {
        results.push(reply.result)
        onResult(reply.result)
      }
    },
    { ...client, signal: controller.signal }
  )
  return { pending, replies, results, close: () => controller.abort() }
}
const metadata = (ids: string[]): AgentSessionStatusEvent => ({
  type: 'snapshot',
  sessions: [],
  namingActiveSessionIds: [],
  setupHeldWorkspaceIds: ids
})

it.each(['complete', 'failure', 'null', 'timeout'] as const)(
  'publishes %s release for an empty workspace without a journal or topology event',
  async (outcome) => {
    vi.useFakeTimers()
    const runtime = new OrcaRuntimeService()
    const topology = vi.spyOn(runtime, 'touchMobileSessionTabsForWorktree')
    const complete = runtime.workspaceSetupAgentStarts.hold('empty-workspace')
    const pending = runtime.workspaceSetupAgentStarts.pending('empty-workspace')
    const stream = open(runtime)
    await stream.pending
    expect(stream.results).toEqual([metadata(['empty-workspace'])])
    expect(stream.results[0]).toHaveProperty('namingActiveSessionIds', [])
    if (outcome === 'timeout') {
      await vi.advanceTimersByTimeAsync(60_000)
    } else {
      complete(
        outcome === 'null'
          ? null
          : () =>
              outcome === 'failure' ? Promise.reject(new Error('setup failed')) : Promise.resolve()
      )
    }
    await pending
    expect(stream.results).toEqual([metadata(['empty-workspace']), metadata([])])
    expect(topology).not.toHaveBeenCalled()
    stream.close()
  }
)

it('publishes only installed identity transitions; a predecessor cannot clear its replacement', async () => {
  const states: string[][] = []
  const holds = new WorkspaceSetupAgentStartHolds()
  const unsubscribe = holds.subscribe(() => states.push(holds.currentWorkspaceIds()))
  const old = holds.hold('workspace')
  const oldPending = holds.pending('workspace')
  const current = holds.hold('workspace')
  const currentPending = holds.pending('workspace')
  old(null)
  await oldPending
  expect(holds.pending('workspace')).toBe(currentPending)
  expect(states).toEqual([['workspace']])
  current(null)
  await currentPending
  expect(states).toEqual([['workspace'], []])
  holds.holdPrepared('immediate', {
    effectiveDecision: 'run',
    hookFound: true,
    shouldRunSetup: true,
    didStartInProcessSetupHook: true,
    inProcessCompletion: Promise.resolve(),
    waitForSetup: false
  })
  expect(holds.pending('immediate')).toBeNull()
  unsubscribe()
})

it('observes in-process setup and release during the initial emission before restoration finishes', async () => {
  const runtime = new OrcaRuntimeService()
  const completion = Promise.withResolvers<void>()
  runtime.workspaceSetupAgentStarts.holdPrepared('in-process', {
    effectiveDecision: 'run',
    hookFound: true,
    shouldRunSetup: true,
    didStartInProcessSetupHook: true,
    inProcessCompletion: completion.promise,
    waitForSetup: true
  })
  const pending = runtime.workspaceSetupAgentStarts.pending('in-process')
  const restoration = Promise.withResolvers<void>()
  const stream = open(
    runtime,
    () => restoration.promise,
    () => completion.resolve()
  )
  await pending
  expect(stream.results).toEqual([metadata(['in-process']), metadata([])])
  restoration.resolve()
  await stream.pending
  stream.close()
  const complete = runtime.workspaceSetupAgentStarts.hold('after-close')
  const final = runtime.workspaceSetupAgentStarts.pending('after-close')
  complete(null)
  await final
  expect(stream.results).toHaveLength(2)
})

it('keeps metadata live for a recorded host refusal while structured operations still refuse', async () => {
  const runtime = new OrcaRuntimeService()
  const refusal = agentSessionRefusalError('agent_session_journal_unreadable', {
    reason: 'journalCorrupt'
  })
  recordStructuredAgentSessionHostInstallRefusal(refusal)
  const stream = open(runtime, async () => {
    throw refusal
  })
  await stream.pending
  const complete = runtime.workspaceSetupAgentStarts.hold('workspace')
  const pending = runtime.workspaceSetupAgentStarts.pending('workspace')
  complete(null)
  await pending
  expect(stream.results).toEqual([metadata([]), metadata(['workspace']), metadata([])])
  const replies: unknown[] = []
  await dispatcher({
    ensureStructuredAgentSessionHost: async () => {
      throw refusal
    }
  }).dispatchStreaming(
    {
      id: 'read',
      authToken: 'token',
      method: 'agentSession.options',
      params: { sessionId: SESSION }
    },
    (raw) => replies.push(JSON.parse(raw)),
    STRUCTURED_CLIENT
  )
  expect(replies).toEqual([
    expect.objectContaining({
      ok: false,
      error: {
        code: 'runtime_error',
        message: refusal.refusal.message,
        data: { refusal: { code: refusal.refusal.code, details: refusal.refusal.details } }
      }
    })
  ])
})

it('does not swallow arbitrary restoration failures or publish to an unsupported audience', async () => {
  const runtime = new OrcaRuntimeService()
  const cleanup = vi.spyOn(runtime, 'registerOwnedSubscriptionCleanup')
  const stream = open(runtime, async () => {
    throw new Error('unrelated I/O failure')
  })
  await stream.pending
  expect(stream.replies.at(-1)).toMatchObject({
    ok: false,
    error: { message: 'unrelated I/O failure' }
  })
  const complete = runtime.workspaceSetupAgentStarts.hold('workspace')
  const pending = runtime.workspaceSetupAgentStarts.pending('workspace')
  complete(null)
  await pending
  expect(stream.results).toEqual([metadata([])])
  const denied = open(
    runtime,
    async () => {},
    () => {},
    { ...STRUCTURED_CLIENT, clientCapabilities: [] }
  )
  await denied.pending
  expect(denied.results).toEqual([])
  expect(denied.replies[0]).toMatchObject({ ok: false })
  expect(cleanup).toHaveBeenCalledOnce()
})

it('bounds actual hold publications by held workspaces/subscribers, not unrelated tabs, at N and 10N', async () => {
  for (const population of [2, 20]) {
    const runtime = new OrcaRuntimeService()
    for (let index = 0; index < population; index++) {
      runtime.projectStructuredAgentSessionTab({
        activate: false,
        sessionId: `chat-${index}`,
        workspaceId: `unrelated-${index}`,
        agent: 'claude'
      })
    }
    const host = hostStub()
    const record = agentSessionRecordFixture()
    const namingIds = [record.sessionId, 'second-naming-job']
    const records = new Map(namingIds.map((id) => [id, { ...record, sessionId: id }]))
    const getRecord = vi
      .spyOn(host.deps.store, 'getRecord')
      .mockImplementation((id) => records.get(id) ?? null)
    vi.spyOn(host.deps.store, 'getConversation').mockImplementation((key) => {
      const record = records.get(key)
      return record ? agentSessionConversationView(record) : null
    })
    const prompt = Promise.withResolvers<string>()
    const naming = createStructuredChatNamingHandler({
      getStore: () => ({
        getRecord,
        compareAndSetConversationName: vi.fn(async () => null),
        setUserConversationName: vi.fn()
      }),
      getSettings: () => ({}),
      workerTaskTitle: () => null,
      readFirstPrompt: () => prompt.promise,
      readJournalFirstPrompt: () => prompt.promise,
      generate: vi.fn(async () => null),
      onNamed: () => {},
      logger: host.deps.logger
    })
    host.deps.conversationNaming = naming
    host.subscribeStatus = () => () => {}
    setStructuredAgentSessionHost(host)
    for (const id of namingIds) {
      naming.regenerate(id)
    }
    getRecord.mockClear()
    const readConversation = vi.mocked(host.deps.store.getConversation)
    readConversation.mockClear()
    const readNaming = vi.spyOn(naming, 'activeSessionIds')
    const topology = vi.spyOn(runtime, 'touchMobileSessionTabsForWorktree')
    const census = vi.spyOn(runtime, 'listAllMobileSessionTabs')
    const read = vi.spyOn(runtime.workspaceSetupAgentStarts, 'currentWorkspaceIds')
    const stream = open(runtime)
    await stream.pending
    for (let index = 0; index < population; index++) {
      const complete = runtime.workspaceSetupAgentStarts.hold('trigger')
      const pending = runtime.workspaceSetupAgentStarts.pending('trigger')
      complete(null)
      await pending
    }
    expect(read).toHaveBeenCalledTimes(1 + 2 * population)
    expect(readNaming).toHaveBeenCalledTimes(1 + 2 * population)
    expect(readConversation).toHaveBeenCalledTimes(namingIds.length * (1 + 2 * population))
    expect(stream.results).toEqual(
      [
        metadata([]),
        ...Array.from({ length: population }, () => [metadata(['trigger']), metadata([])]).flat()
      ].map((frame) => ({ ...frame, namingActiveSessionIds: namingIds }))
    )
    expect(topology).not.toHaveBeenCalled()
    expect(census).not.toHaveBeenCalled()
    stream.close()
    prompt.resolve('')
    await vi.waitFor(() => expect(naming.activeSessionIds()).toEqual([]))
  }
})

it('an older snapshot fold ignores the optional list and missing metadata adds no session or hold', () => {
  const before = new Map<string, AgentSessionStatusSummary>()
  expect(foldAgentSessionStatusEvent(before, metadata(['workspace']))).toEqual(before)
  expect(foldAgentSessionStatusEvent(before, { type: 'snapshot', sessions: [] })).toEqual(before)
})

it('keeps shipped Sleep visibility and menu unknown through real setup frames until restoration answers', async () => {
  const runtime = new OrcaRuntimeService()
  const record = { ...agentSessionRecordFixture(), sleptAt: 5 }
  const id = record.sessionId
  const privateRecord = { ...record, sessionId: 'private-pi', provider: 'pi' as const }
  const records = new Map([
    [id, record],
    [privateRecord.sessionId, privateRecord]
  ])
  const prompt = Promise.withResolvers<string>()
  const restoration = Promise.withResolvers<void>()
  const host = hostStub()
  const getRecord = vi
    .spyOn(host.deps.store, 'getRecord')
    .mockImplementation((key) => records.get(key) ?? null)
  const getConversation = vi.spyOn(host.deps.store, 'getConversation').mockImplementation((key) => {
    const record = records.get(key)
    return record ? agentSessionConversationView(record) : null
  })
  const naming = createStructuredChatNamingHandler({
    getStore: () => ({
      getRecord,
      compareAndSetConversationName: vi.fn(async () => null),
      setUserConversationName: vi.fn()
    }),
    getSettings: () => ({}),
    workerTaskTitle: () => null,
    readFirstPrompt: () => prompt.promise,
    readJournalFirstPrompt: () => prompt.promise,
    generate: vi.fn(async () => null),
    onNamed: (_workspace, sessionId) => feed.publishConversationName(sessionId),
    logger: host.deps.logger
  })
  host.deps.conversationNaming = naming
  const journalRoot = await mkdtemp(join(tmpdir(), 'orca-setup-sleep-'))
  journalRoots.push(journalRoot)
  const journal = await journals.open({
    identity: {
      sessionId: id,
      workspaceId: record.location.workspaceId,
      hostId: 'local',
      agent: record.provider,
      providerHandle: record.providerHandleChain[0]!.handle
    },
    now: () => 1,
    stateDirectory: join(journalRoot, id)
  })
  const feed = new StructuredAgentSessionStatusFeed({
    sessions: new Map([
      [id, { journal, params: { location: record.location, provider: record.provider } }]
    ]),
    getConversation,
    now: () => 1,
    logger: host.deps.logger,
    namingActiveSessionIds: naming.activeSessionIds
  })
  host.subscribeStatus = (subscriber) => feed.subscribe(subscriber)
  setStructuredAgentSessionHost(host)
  naming.regenerate(id)
  naming.regenerate(privateRecord.sessionId)
  expect(naming.activeSessionIds()).toEqual([id, privateRecord.sessionId])
  const old = getStructuredAgentSessionStatusFeed({ kind: 'local' })
  legacyTransport.subscribe.mockResolvedValue({ unsubscribe: () => {} })
  const deactivate = old.activate()
  const receive: (event: AgentSessionStatusEvent) => void =
    legacyTransport.subscribe.mock.calls[0][1]
  const deliver = (event: AgentSessionStatusEvent) => {
    if (event.type === 'snapshot') {
      // d79 cannot read the new member; this forces its exact naming-only Sleep predicate.
      const { setupHeldWorkspaceIds: _unknown, ...shipped } = event
      receive(shipped)
    } else {
      receive(event)
    }
  }
  const workspace = makeWorktree({
    id: record.location.workspaceId,
    instanceId: 'instance',
    displayName: 'Sleeping',
    branch: 'sleeping',
    sortOrder: 0
  })
  const tab: Tab = {
    id: 'saved-chat',
    worktreeId: workspace.id,
    contentType: 'agent-session',
    agentSessionAgent: 'claude',
    groupId: 'saved-group',
    entityId: id,
    label: 'Saved chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
  const unifiedTabsByWorktree = { [workspace.id]: [tab] }
  const projection = () => {
    const sleptAt = old.getSessionSleepState(id)
    const structuredChatSleptAtByPaneKey =
      sleptAt === undefined ? {} : { [structuredAgentSessionPaneKey(tab.id, id)]: sleptAt }
    const activity = {
      tabsByWorktree: {},
      ptyIdsByTabId: {},
      browserTabsByWorktree: {},
      unifiedTabsByWorktree,
      agentStatusByPaneKey: {},
      structuredChatSleptAtByPaneKey
    }
    const awake = getWorktreeIdsWithStructuredChat(
      unifiedTabsByWorktree,
      structuredChatSleptAtByPaneKey
    )
    const visible = filterWorkspaceRows(
      [workspace],
      { ...NO_WORKSPACE_ROW_FILTERS, hideSleepingWorkspaces: true },
      buildDesktopWorkspaceRowFactReader({
        ...activity,
        repoMap: new Map(),
        defaultHostId: 'local',
        pairedDeviceIdsByEnvironment: new Map(),
        worktreeIdsWithLiveAgent: new Set(),
        worktreeIdsWithStructuredChat: awake
      })
    )
    return {
      sleptAt,
      awake: [...awake],
      visible: visible.map((row) => row.id),
      sleepMenuEnabled: hasSleepableWorkspaceActivity(workspace.id, activity)
    }
  }
  const unknown = { sleptAt: undefined, awake: [], visible: [], sleepMenuEnabled: false }
  expect(projection()).toEqual(unknown)
  const stream = open(runtime, () => restoration.promise, deliver)
  try {
    expect(projection()).toEqual(unknown)
    expect(stream.results).toEqual([{ ...metadata([]), namingActiveSessionIds: [id] }])
    expect(old.getNamingActive(id)).toBe(true)
    expect(old.getNamingActive(privateRecord.sessionId)).toBe(false)
    expect(old.getSnapshot().size).toBe(0)
    expect(projection()).toEqual(unknown)
    const complete = runtime.workspaceSetupAgentStarts.hold(workspace.id)
    const pending = runtime.workspaceSetupAgentStarts.pending(workspace.id)
    complete(null)
    await pending
    expect(stream.results).toEqual(
      [metadata([]), metadata([workspace.id]), metadata([])].map((frame) => ({
        ...frame,
        namingActiveSessionIds: [id]
      }))
    )
    expect(old.getNamingActive(id)).toBe(true)
    expect(projection()).toEqual(unknown)
    restoration.resolve()
    await stream.pending
    expect(old.getSnapshot().get(id)?.sleptAt).toBe(5)
    expect(projection()).toEqual({ ...unknown, sleptAt: 5 })
    prompt.resolve('')
    await vi.waitFor(() => expect(naming.activeSessionIds()).toEqual([]))
    expect(old.getNamingActive(id)).toBe(false)
    expect(projection()).toEqual({ ...unknown, sleptAt: 5 })
    expect(naming.activeSessionIds()).toEqual([])
  } finally {
    prompt.resolve('')
    restoration.resolve()
    await stream.pending
    stream.close()
    deactivate()
  }
})
