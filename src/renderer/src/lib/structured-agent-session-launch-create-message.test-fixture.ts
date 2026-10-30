// @vitest-environment happy-dom
import { vi, type Mock } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionHistoryPage } from '../../../shared/agent-session-wire'
import {
  CreateIntentParams,
  SetOptionParams,
  SendParams
} from '../../../shared/rpc-contract/structured-agent-session-params'

import type { HostCreateSupport } from './structured-agent-session-host-admission'

type CreateMessageFixtureMocks = {
  call: Mock<(target: unknown, method: string, params: unknown) => Promise<unknown>>
  supports: Mock<() => Promise<boolean>>
  supportsMode: Mock<() => Promise<boolean>>
  exactSupport: Mock<() => Promise<boolean>>
  admit: Mock<() => Promise<HostCreateSupport>>
  inventory: Mock
  settings: Record<string, unknown>
}

const mocks: CreateMessageFixtureMocks = vi.hoisted(() => {
  const settings: Record<string, unknown> = {}
  return {
    call: vi.fn<(target: unknown, method: string, params: unknown) => Promise<unknown>>(),
    supports: vi.fn<() => Promise<boolean>>(),
    supportsMode: vi.fn<() => Promise<boolean>>(),
    exactSupport: vi.fn<() => Promise<boolean>>(),
    admit: vi.fn<() => Promise<HostCreateSupport>>(),
    inventory: vi.fn(),
    settings
  }
})
const layoutOwner = vi.hoisted(() => ({ isMain: false }))
vi.mock('../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.isMain
  }
}))
// This machine's host closes the chat's tab when asked.
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn(async () => ({})) }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  supportsStructuredAgentSessionCreateOptionsMode: mocks.supportsMode,
  supportsStructuredAgentSessionCreateMessage: mocks.supports,
  structuredAgentSessionHostSupports: mocks.exactSupport
}))
vi.mock('./structured-agent-session-host-admission', () => ({
  askHostCreateSupport: mocks.admit
}))
vi.mock('@/runtime/structured-session-tab-inventory', () => ({
  readStructuredSessionTabInventory: mocks.inventory
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      runtimeEnvironmentCatalogHydrated: true,
      settings: mocks.settings,
      unifiedTabsByWorktree: {},
      groupsByWorktree: {},
      seedNativeChatLaunchDraft: vi.fn(),
      clearNativeChatLaunchDraft: vi.fn()
    }),
    subscribe: () => () => {}
  }
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/structured-chat-host-permission', () => ({
  readStructuredChatHostPermissionVerdict: async () => ({ kind: 'allowed' })
}))

import { useAppStore } from '@/store'
import { registerStructuredSelectionCatalogStore } from './structured-agent-session-selection-controller'
import { resetStructuredAgentLaunchRegistryForTests } from './agent-session/launch/structured-agent-session-launch-registry'
import { resetStructuredAgentLaunchPersistenceForTests } from './agent-session/launch/structured-agent-session-launch-persistence'
import { resetStructuredAgentSessionSendsForTests } from '@/components/native-chat/structured-agent-session-message-sender'
import { resetStructuredAgentSessionReadOwnersForTests } from '@/components/native-chat/structured-agent-session-read-owner'
import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/host-model-catalog-snapshots'
import { startStructuredAgentLaunch } from './structured-agent-session-launch'
import { newAgentLaunchRequestId } from './agent-launch-request-id'

import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache
} from '@/components/native-chat/native-chat-draft-cache'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/native-chat-composer-draft-store'

export function resetCreateMessageFixture() {
  const restore = registerStructuredSelectionCatalogStore({
    read: useAppStore.getState,
    subscribe: useAppStore.subscribe
  })
  vi.useFakeTimers()
  vi.clearAllMocks()
  layoutOwner.isMain = false
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
function created() {
  const params = createParams()
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
    requestId: newAgentLaunchRequestId(),
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
    requestId: newAgentLaunchRequestId(),
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
    requestId: newAgentLaunchRequestId(),
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
