import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
// @vitest-environment happy-dom
import { vi, type Mock } from 'vitest'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { AgentJournalSubmission } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionHistoryPage } from '../../../../../shared/agent-session/agent-session-wire'
import {
  CreateIntentParams,
  SetOptionParams,
  SendParams
} from '../../../../../shared/rpc-contract/structured-agent-session-params'
import type { Tab } from '../../../../../shared/tab-types'
import type { HostCreateSupport } from './structured-agent-session-host-admission'
import { useAppStore } from '../../../store/index'
import { registerStructuredSelectionCatalogStore } from '../options/structured-agent-session-selection-controller'
import { resetStructuredAgentLaunchRegistryForTests } from './structured-agent-session-launch-registry'
import { resetStructuredAgentLaunchPersistenceForTests } from './structured-agent-session-launch-persistence'
import { resetStructuredAgentSessionSendsForTests } from '../../../components/native-chat/session/structured/delivery/structured-agent-session-message-sender'
import '../../../components/native-chat/session/structured/read/structured-agent-session-read-owner'
import { resetStructuredAgentSessionReadOwnersForTests } from '../../../components/native-chat/session/structured/read/structured-agent-session-read-owner-registry'
import { resetHostModelCatalogSnapshotsForTests } from '../../../runtime/native-chat/model-catalogs/host-model-catalog-snapshots'
import { startStructuredAgentLaunch } from './structured-agent-session-launch'

import { createNonSecureContextUuid } from '../../../../../shared/non-secure-context-uuid'
import { clearNativeChatComposerDraftsForTests as clearNativeChatDraftCacheForTests } from '../../../components/native-chat/drafts/native-chat-draft-reset'
import { readNativeChatDraftCache } from '../../../components/native-chat/drafts/native-chat-draft-views'
import { structuredAgentSessionDraftScopeKey } from '../../../components/native-chat/drafts/native-chat-draft-scope'

type CreateMessageFixtureMocks = {
  rpc: Mock
  hostBusy: boolean
  tabs: Tab[]
  call: Mock<(target: unknown, method: string, params: unknown) => Promise<unknown>>
  supports: Mock<() => Promise<boolean>>
  supportsMode: Mock<() => Promise<boolean>>
  exactSupport: Mock<(target?: unknown, capability?: string) => Promise<boolean>>
  admit: Mock<() => Promise<HostCreateSupport>>
  inventory: Mock
  settings: Record<string, unknown>
  runtimeStatusByEnvironmentId: Map<
    string,
    { status: { capabilities: string[]; hostPlatform: string } }
  >
}

const mocks: CreateMessageFixtureMocks = vi.hoisted(() => {
  const settings: Record<string, unknown> = {}
  return {
    rpc: vi.fn(async () => ({})),
    hostBusy: false,
    tabs: [],
    call: vi.fn<(target: unknown, method: string, params: unknown) => Promise<unknown>>(),
    supports: vi.fn<() => Promise<boolean>>(),
    supportsMode: vi.fn<() => Promise<boolean>>(),
    exactSupport: vi.fn<(target?: unknown, capability?: string) => Promise<boolean>>(),
    admit: vi.fn<() => Promise<HostCreateSupport>>(),
    inventory: vi.fn(),
    settings,
    runtimeStatusByEnvironmentId: new Map()
  }
})
const layoutOwner = vi.hoisted(() => ({ isMain: false }))
vi.mock('../../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.isMain
  }
}))
// This machine's host closes the chat's tab when asked.
vi.mock('../../../runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: mocks.rpc
}))
vi.mock('../../../runtime/native-chat/status/structured-agent-session-status-feed', () => {
  const idle = { status: 'idle', hostExecutionPhase: 'idle' }
  const working = { status: 'working', hostExecutionPhase: 'idle' }
  const feed = {
    activate: () => () => {},
    subscribe: () => () => {},
    subscribeSession: () => () => {},
    getSnapshot: () => ({ get: () => (mocks.hostBusy ? working : idle) }),
    getSessionObservation: () => 'live'
  }
  return { getStructuredAgentSessionStatusFeed: () => feed }
})
vi.mock('../../../runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: mocks.call
}))

vi.mock('@/runtime/native-chat/host-capabilities/structured-agent-session-host-support', () => ({
  supportsStructuredAgentSessionCreateOptionsMode: mocks.supportsMode,
  supportsStructuredAgentSessionCreateMessage: mocks.supports,
  structuredAgentSessionHostSupports: mocks.exactSupport,
  structuredAgentSessionHostCapabilityState: async (target: unknown, capability: string) =>
    (await mocks.exactSupport(target, capability)) ? 'supported' : 'unsupported'
}))
vi.mock('./structured-agent-session-host-admission', () => ({
  askHostCreateSupport: mocks.admit
}))
vi.mock('../../../runtime/native-chat/tab-inventory/structured-session-tab-inventory', () => ({
  readStructuredSessionTabInventory: mocks.inventory
}))
vi.mock('../../../store/index', () => {
  const getState = () => ({
    runtimeEnvironmentCatalogHydrated: true,
    settings: mocks.settings,
    unifiedTabsByWorktree: { 'workspace-1': mocks.tabs },
    agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({})),
    runtimeStatusByEnvironmentId: mocks.runtimeStatusByEnvironmentId,
    groupsByWorktree: {},
    seedNativeChatLaunchDraft: vi.fn(),
    clearNativeChatLaunchDraft: vi.fn()
  })
  return {
    useAppStore: Object.assign(
      (selector: (state: ReturnType<typeof getState>) => unknown) => selector(getState()),
      { getState, subscribe: () => () => {} }
    )
  }
})
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('../../../runtime/native-chat/host-capabilities/structured-chat-host-permission', () => ({
  readStructuredChatHostPermissionVerdict: async () => ({ kind: 'allowed' })
}))

export function resetCreateMessageFixture() {
  const restore = registerStructuredSelectionCatalogStore({
    read: useAppStore.getState,
    subscribe: useAppStore.subscribe
  })
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.runtimeStatusByEnvironmentId.clear()
  layoutOwner.isMain = false
  mocks.hostBusy = false
  mocks.tabs = []
  localStorage.clear()
  resetStructuredAgentLaunchRegistryForTests()
  resetStructuredAgentLaunchPersistenceForTests()
  resetStructuredAgentSessionSendsForTests()
  resetStructuredAgentSessionReadOwnersForTests()
  clearNativeChatDraftCacheForTests()
  mocks.supports.mockResolvedValue(true)
  mocks.supportsMode.mockResolvedValue(true)
  mocks.exactSupport.mockResolvedValue(false)
  resetHostModelCatalogSnapshotsForTests()
  mocks.admit.mockResolvedValue({ kind: 'admitted' })
  mocks.inventory.mockRejectedValue(new Error('an extra inventory read must not gate create'))
  return restore
}

export function cleanupCreateMessageFixture(restore?: () => void) {
  resetStructuredAgentLaunchRegistryForTests()
  restore?.()
  resetStructuredAgentSessionSendsForTests()
  resetStructuredAgentSessionReadOwnersForTests()
  vi.useRealTimers()
}

function deferred<T>() {
  return Promise.withResolvers<T>()
}
function createParams() {
  return CreateIntentParams.parse(
    mocks.call.mock.calls.find(([, method]) => method === 'agentSession.create')?.[2]
  )
}
function submission(clientMessageId: string): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: 'a'.repeat(64),
    dispatchState: 'pending',
    handoverRecorded: true,
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null
  }
}
function created(params = createParams()) {
  const rows = params.firstMessage ? [submission(params.firstMessage.clientMessageId)] : []
  const cursor = { epoch: 'epoch-1', sequence: rows.length }
  const page: AgentSessionHistoryPage = {
    sessionId: params.envelope.sessionId,
    epoch: cursor.epoch,
    fence: 1,
    direction: 'tail',
    items: [],
    removedItemIds: [],
    submissions: rows,
    window: { oldest: null, newest: null, nextCursor: cursor },
    liveCursor: cursor,
    hasOlder: false,
    hasNewer: false,
    latestTurn: null
  }
  return {
    ok: true,
    replayed: false,
    value: { sessionId: page.sessionId, fence: 1, page, unconfirmedClientMessageIds: [] }
  }
}
const target = { kind: 'local' } as const
const start = () =>
  startStructuredAgentLaunch('workspace-1', 'codex', {
    requestId: createNonSecureContextUuid(),
    executionHostId: 'local',
    prompt: 'opening text'
  })
const draft = (sessionId: string) =>
  readNativeChatDraftCache(structuredAgentSessionDraftScopeKey(sessionId))

// An older host (no create-message) applies an action's explicit options one setOption at a time.
function startLegacyActionLaunch(
  launchOptions: Record<string, string>,
  refusedKey: string,
  refusal: Record<string, unknown> | Error
) {
  mocks.supports.mockResolvedValue(false)
  mocks.call.mockImplementation(async (_target, method, params) => {
    if (method === 'agentSession.create') {
      return created()
    }
    if (method === 'agentSession.setOption') {
      const key = params && typeof params === 'object' && 'key' in params ? params.key : null
      if (key === refusedKey && refusal instanceof Error) {
        throw refusal
      }
      return key === refusedKey
        ? { ok: false, refusal }
        : { ok: true, value: { options: { model: launchOptions.model } } }
    }
    const send = SendParams.parse(params)
    const clientMessageId = send.envelope.clientOperationId
    return { ok: true, value: { clientMessageId, submission: submission(clientMessageId) } }
  })
  const launch = startStructuredAgentLaunch('workspace-1', 'codex', {
    requestId: createNonSecureContextUuid(),
    executionHostId: 'local',
    prompt: 'opening text',
    launchOptions
  })
  mocks.inventory.mockResolvedValue([
    { worktree: 'workspace-1', tabs: [{ type: 'agent-session', sessionId: launch.sessionId }] }
  ])
  return launch
}

export {
  mocks,
  layoutOwner,
  deferred,
  createParams,
  submission,
  created,
  target,
  start,
  draft,
  startLegacyActionLaunch
}

export function legacyAction(
  explicit: Record<string, string> | undefined,
  write: (key: string, value: string) => Promise<unknown>,
  executionHostId: ExecutionHostId = 'local',
  agent: 'claude' | 'codex' = 'codex'
) {
  const create = deferred<unknown>()
  mocks.supports.mockResolvedValue(false)
  mocks.call.mockImplementation(async (_target, method, params) => {
    if (method === 'agentSession.create') {
      return create.promise
    }
    if (method === 'agentSession.setOption') {
      const { key, value } = SetOptionParams.parse(params)
      return write(key, value)
    }
    if (method === 'agentSession.history') {
      return { ok: true, page: { ...created().value.page, fence: 2 } }
    }
    const send = SendParams.parse(params)
    return {
      ok: true,
      value: {
        clientMessageId: send.envelope.clientOperationId,
        submission: submission(send.envelope.clientOperationId)
      }
    }
  })
  const launch = startStructuredAgentLaunch('workspace-1', agent, {
    requestId: createNonSecureContextUuid(),
    executionHostId,
    prompt: 'opening text',
    ...(explicit ? { launchOptions: explicit } : {}),
    ...(executionHostId !== 'local' ? { hostSeedOptions: { model: 'gpt-5.5' } } : {})
  })
  mocks.inventory.mockResolvedValue([
    { worktree: 'workspace-1', tabs: [{ type: 'agent-session', sessionId: launch.sessionId }] }
  ])
  return { launch, create }
}
export const acceptedOption = (key: string, value: string) => ({
  ok: true,
  value: { key, value, options: { [key]: value } }
})
export const refusedOption = {
  ok: false,
  refusal: { code: 'agent_session_operation_invalid', details: { reason: 'optionRejected' } }
}
export const optionCalls = () =>
  mocks.call.mock.calls
    .filter(([, method]) => method === 'agentSession.setOption')
    .map(([, , params]) => SetOptionParams.parse(params))
