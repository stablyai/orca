// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import type { WorktreeCreationRequest } from './pending-worktree-creation'
import type { AgentLaunchResult } from '../../../shared/agent-launch-intent'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'

const mocks = vi.hoisted(() => {
  const pendingWorktreeCreations: Record<string, unknown> = { 'creation-1': {} }
  return {
    capabilities: vi.fn(),
    rpc: vi.fn(),
    draft: vi.fn(),
    close: vi.fn(),
    reveal: vi.fn(),
    ready: vi.fn(),
    complete: vi.fn(),
    refresh: vi.fn(),
    terminalPrompt: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    seedTerminal: vi.fn(),
    state: {
      repos: [{ id: 'repo-1', executionHostId: 'local' }],
      settings: {},
      sortBy: 'manual',
      activeView: 'terminal',
      activePendingCreationId: 'creation-1',
      activeWorktreeId: null,
      pendingWorktreeCreations,
      updatePendingWorktreeCreation: vi.fn(),
      closeUnifiedTab: vi.fn(),
      seedNativeChatLaunchDraft: vi.fn(),
      seedNativeChatLaunchPrompt: vi.fn(),
      unifiedTabsByWorktree: {}
    }
  }
})
vi.mock('@/store', () => ({
  useAppStore: { getState: () => mocks.state, subscribe: mocks.subscribe }
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  ensureLocalRuntimeCapabilities: mocks.capabilities
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.rpc,
  getRuntimeEnvironmentStatus: vi.fn()
}))
vi.mock('@/store/slices/worktrees/create/worktree-create-parent-pick', () => ({
  resolveWorktreeCreateParent: () => ({ staleBeforeCreate: false }),
  notifyWorktreeParentDropped: vi.fn()
}))
vi.mock('@/lib/worktree-creation-host-result', () => ({
  acceptHostCreatedWorktree: (_target: unknown, launch: AgentLaunchResult) => launch.created,
  materializeHostCreatedWorktree: mocks.refresh
}))
vi.mock('@/components/native-chat/native-chat-session-option-cache', () => ({
  seedNativeChatAppliedSessionOptions: vi.fn()
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: (target: unknown, method: string, params?: unknown) =>
    mocks.rpc(target, method, params)
}))
vi.mock('@/runtime/structured-agent-session-tab-retirement', () => ({
  beginStructuredAgentSessionTabClose: mocks.close
}))
vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  deliverLaunchPromptToAgentTab: mocks.terminalPrompt
}))
vi.mock('@/runtime/web-runtime-session-tab-lifecycle', () => ({
  closeWebRuntimeSessionTab: vi.fn()
}))
vi.mock('@/lib/worktree-initial-terminal-seeding', () => ({
  ensureWorktreeHasInitialTerminal: mocks.seedTerminal
}))
vi.mock('@/lib/worktree-creation-background-mount', () => ({
  mountCreatedWorktreeStartupTabsInBackground: vi.fn()
}))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: mocks.reveal }))
vi.mock('@/lib/worktree-creation-ready-toast', () => ({
  showWorktreeCreationReadyToast: mocks.ready
}))
vi.mock('@/lib/worktree-creation-completion', () => ({ completeWorktreeCreation: mocks.complete }))

import { createWorktreeThroughHost } from './worktree-creation-through-host'

const capabilities = [
  'agent.launch.v2',
  'agent.launch.replay-required.v1',
  'agent.launch.surface.v1',
  'agent.launch.desktop-create.v1'
]
const result: AgentLaunchResult = {
  worktreeId: 'wt-1',
  created: { worktree: makeWorktree({ id: 'wt-1', repoId: 'repo-1' }) },
  outcome: { kind: 'structured', sessionId: 'claude_created', handle: 'chat_created' },
  receipt: {
    mode: 'structured',
    preferred: 'structured',
    reason: 'requested',
    detail: 'Chat requested'
  }
}
function request(): WorktreeCreationRequest {
  return {
    repoId: 'repo-1',
    name: 'feature',
    setupDecision: 'inherit',
    agent: 'claude',
    agentLaunchRoute: 'structured-native-chat',
    pendingFirstAgentMessageRename: true,
    note: '',
    startupPlan: null,
    quickPrompt: 'Fix the bug',
    quickTelemetry: null
  }
}

import { resetStructuredAgentSessionSendsForTests } from '@/components/native-chat/structured-agent-session-message-sender'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache
} from '@/components/native-chat/native-chat-draft-cache'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/native-chat-composer-draft-store'
import { deriveAgentLaunchChildOperationId } from '../../../shared/agent-launch-child-operation'
import { getStructuredAgentSessionPendingSends } from '@/components/native-chat/structured-agent-session-pending-sends'
import {
  discardStructuredLaunchPrompts,
  hasStagedStructuredLaunchPrompt
} from './structured-agent-session-launch-prompt'

it.each([false, true])(
  'keeps host ownership of the frozen opening prompt through completion (lost acknowledgement=%s)',
  async (lost) => {
    vi.clearAllMocks()
    localStorage.clear()
    resetStructuredAgentSessionSendsForTests()
    clearNativeChatDraftCacheForTests()
    mocks.subscribe.mockReturnValue(mocks.unsubscribe)
    mocks.capabilities.mockResolvedValue(capabilities)
    mocks.state.pendingWorktreeCreations = { 'creation-1': {} }
    const pending = { ...request(), promptDelivery: 'auto-submit' as const }
    let calls = 0
    mocks.rpc.mockImplementation(async (_target, method, params) => {
      if (method === 'agent.launchReplay') {
        calls++
        if (lost && calls === 1) {
          throw new Error('connection lost after host committed')
        }
        return {
          ...result,
          outcome: { ...result.outcome, sessionId: params.sessionId },
          prompt: {
            delivery: 'submit',
            outcome: 'journaled',
            messageId: deriveAgentLaunchChildOperationId(
              deriveAgentLaunchChildOperationId(params.operationId) ?? ''
            )
          }
        }
      }
      if (method === 'agentSession.history') {
        return { ok: true, page: { fence: 1 } }
      }
      throw new Error(`Unexpected method ${method}`)
    })
    try {
      if (lost) {
        await expect(createWorktreeThroughHost('creation-1', pending)).rejects.toThrow(
          'connection lost'
        )
      }
      if (lost) {
        pending.quickPrompt = 'newer edit must not replace the submitted input'
      }
      await expect(createWorktreeThroughHost('creation-1', pending)).resolves.toBe(true)
      for (let i = 0; i < 40; i++) {
        await Promise.resolve()
      }
      const launches = mocks.rpc.mock.calls.filter(([, method]) => method === 'agent.launchReplay')
      expect(launches.every(([, , payload]) => payload.prompt?.text === 'Fix the bug')).toBe(true)
      if (lost) {
        expect(launches[1]?.[2]).toEqual(launches[0]?.[2])
      }
      const sessionId = pending.hostAgentLaunch?.sessionId
      if (!sessionId) {
        throw new Error('missing reservation identity')
      }
      const sends = mocks.rpc.mock.calls.filter(([, method]) => method === 'agentSession.send')
      expect({
        sends: sends.length,
        draft: readNativeChatDraftCache(structuredAgentSessionDraftScopeKey(sessionId))
      }).toEqual({ sends: 0, draft: '' })
      expect(hasStagedStructuredLaunchPrompt(sessionId)).toBe(false)
      expect(getStructuredAgentSessionPendingSends(sessionId)).toEqual([])
    } finally {
      if (pending.hostAgentLaunch) {
        discardStructuredLaunchPrompts(pending.hostAgentLaunch.sessionId)
      }
      resetStructuredAgentSessionSendsForTests()
    }
  }
)
