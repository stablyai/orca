// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as HostPermission from '@/runtime/native-chat/host-capabilities/structured-chat-host-permission'
import type { Worktree } from '../../src/shared/worktree/types'

const mocks = vi.hoisted(() => ({
  createSupport: vi.fn(),
  toastInfo: vi.fn(),
  toastError: vi.fn(),
  launchAgentInNewTab: vi.fn(),
  hostPermission: vi.fn(),
  writerCapability: vi.fn(async () => 'supported')
}))

vi.mock('sonner', () => ({ toast: { info: mocks.toastInfo, error: mocks.toastError } }))
vi.mock('@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab', () => ({
  launchAgentInNewTabWithOutcome: mocks.launchAgentInNewTab
}))
vi.mock('@/lib/agent-session/resume/history/ai-vault-session-resume-preparation', () => ({
  prepareAiVaultSessionForResume: async () => ({ sessionId: 'provider-1' })
}))
vi.mock(
  '../../src/renderer/src/runtime/native-chat/requests/structured-agent-session-call',
  () => ({
    callStructuredAgentSession: vi.fn(async (_target: unknown, method: string, params: unknown) => {
      if (method === 'agentSession.createSupport') {
        return mocks.createSupport(params)
      }
      return new Promise(() => undefined)
    })
  })
)

vi.mock(
  '../../src/renderer/src/runtime/native-chat/host-capabilities/structured-agent-session-host-support',
  () => ({
    structuredAgentSessionHostSupports: async () => true,
    structuredAgentSessionHostCapabilityState: mocks.writerCapability
  })
)

vi.mock(
  '@/runtime/native-chat/host-capabilities/structured-chat-host-permission',
  async (importOriginal) => ({
    ...(await importOriginal<typeof HostPermission>()),
    readStructuredChatHostPermissionVerdict: mocks.hostPermission
  })
)
// Switch-on, main opens this machine's chats and its frames draw them.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

import { useAppStore } from '@/store'
import { adoptAgentSessionLaunchVerdict } from '../../src/renderer/src/lib/agent-session/launch/routing/agent-session-launch-plan'
import { beginStructuredAgentSessionProvisionalLaunch } from '../../src/renderer/src/lib/agent-session/structured-agent-session-provisional-tab'
import '../../src/renderer/src/lib/workspace/creation/work-item/launch-work-item-direct-agent-routing'
import { getStructuredAgentLaunchStatus } from '../../src/renderer/src/lib/agent-session/launch/structured-agent-session-launch-status'
import { getStructuredAgentSessionLaunchSelection } from '../../src/renderer/src/lib/agent-session/launch/structured-agent-session-launch-options'
import { peekWebSessionFocusIntent } from '@/runtime/web-session-tabs-sync/navigation/web-session-focus-intent'
import { structuredAgentSessionFocusOwner } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { readNativeChatComposerDraft } from '@/components/native-chat/drafts/native-chat-composer-draft-store'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/drafts/native-chat-draft-scope'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs/tabs-drawn-from-main.test-fixture'

const WORKTREE = 'repo-1::/srv/app'
const INITIAL_SETTINGS = useAppStore.getState().settings

function pairedPlan(
  overrides: { resumeFrom?: { providerSessionId: string }; executionHostId?: 'local' } = {}
) {
  return adoptAgentSessionLaunchVerdict({
    requestId: 'request-1',
    route: 'structured-native-chat',
    agent: 'claude',
    worktreeId: WORKTREE,
    executionHostId: 'runtime:server-1',
    prompt: 'fix the flaky test',
    promptDelivery: 'auto-submit',
    ...overrides
  })
}

const localPlan = () => pairedPlan({ executionHostId: 'local' })

/** The workspace's row names the paired server as its owner, whose layout draws its tabs. */
function seedPairedServerWorkspace(): void {
  const worktree: Worktree = {
    id: WORKTREE,
    repoId: 'repo-1',
    path: '/srv/app',
    head: 'abc',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true,
    displayName: 'app',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    hostId: 'runtime:server-1',
    runtimeOwnerEnvironmentId: 'server-1'
  }
  useAppStore.setState({ worktreesByRepo: { 'repo-1': [worktree] } })
}

/** Nothing of a chat exists on this machine: no tab, launch, record, queued prompt or intent. */
function expectNoChatCommitted(): void {
  expect(useAppStore.getState().unifiedTabsByWorktree[WORKTREE] ?? []).toEqual([])
  expect(getStructuredAgentLaunchStatus(WORKTREE, 'claude')).toBe('idle')
  expect(Object.keys(localStorage)).toEqual([])
  expect(peekWebSessionFocusIntent({ environmentId: 'server-1' }, WORKTREE)).toBeNull()
  expect(
    peekWebSessionFocusIntent(structuredAgentSessionFocusOwner({ kind: 'local' }), WORKTREE)
  ).toBeNull()
}

let main: TabsDrawnFromMain

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.hostPermission.mockResolvedValue({ kind: 'allowed' })
  localStorage.clear()
  useAppStore.setState({
    activeWorktreeId: WORKTREE,
    activeWorkspaceExecutionHostId: null,
    unifiedTabsByWorktree: {},
    worktreesByRepo: {},
    settings: INITIAL_SETTINGS
  })
  main = await drawTabsFromMain(useAppStore)
})

afterEach(() => {
  main.close()
  vi.restoreAllMocks()
})

describe('a structured chat launch on a paired server', () => {
  beforeEach(seedPairedServerWorkspace)

  it('opens nothing and says so once when the server cannot be reached', async () => {
    mocks.createSupport.mockRejectedValue(new Error('connection lost'))
    const onHostDeclined = vi.fn()

    const launch = beginStructuredAgentSessionProvisionalLaunch({
      plan: pairedPlan(),
      hooks: {},
      onHostDeclined
    })

    await expect(launch?.settlement).resolves.toMatchObject({ kind: 'failed' })
    await expect(launch?.promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: true
    })
    expect(mocks.toastError).toHaveBeenCalledOnce()
    expect(onHostDeclined).not.toHaveBeenCalled()
    expectNoChatCommitted()
  })

  it('leaves no destination when the server declines a resume', async () => {
    mocks.createSupport.mockResolvedValue({ supported: false })
    const onHostDeclined = vi.fn()
    const launch = beginStructuredAgentSessionProvisionalLaunch({
      plan: pairedPlan({ resumeFrom: { providerSessionId: 'provider-1' } }),
      hooks: {},
      onHostDeclined
    })
    await expect(launch?.settlement).resolves.toMatchObject({ kind: 'failed' })
    expect(mocks.createSupport).toHaveBeenCalledOnce()
    expect(onHostDeclined).not.toHaveBeenCalled()
    expectNoChatCommitted()
  })

  // The picker shows what create will run: the server's saved selection, not this machine's.
  it('seeds the chat with the selection the admitting server reported', async () => {
    mocks.createSupport.mockResolvedValue({ supported: true, seedOptions: { model: 'opus' } })
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings!,
        nativeChatSessionOptions: { claude: { model: 'sonnet' } }
      }
    })

    const launch = beginStructuredAgentSessionProvisionalLaunch({
      plan: pairedPlan(),
      hooks: {},
      onHostDeclined: vi.fn()
    })
    await vi.waitFor(() =>
      expect(useAppStore.getState().unifiedTabsByWorktree[WORKTREE]).toHaveLength(1)
    )
    const sessionId = useAppStore.getState().unifiedTabsByWorktree[WORKTREE]![0]!.entityId

    expect(getStructuredAgentSessionLaunchSelection(sessionId)?.seed).toEqual({ model: 'opus' })
    launch?.cancel()
  })

  // An unread capability is neither an older server nor an unreachable one: the resume asks the
  // plain question and create decides, as before the early writer question existed.
  it('opens a resumed chat when the server could not say what it supports', async () => {
    mocks.writerCapability.mockResolvedValueOnce('unknown')
    mocks.createSupport.mockResolvedValue({ supported: true })

    const launch = beginStructuredAgentSessionProvisionalLaunch({
      plan: pairedPlan({ resumeFrom: { providerSessionId: 'provider-1' } }),
      hooks: {},
      onHostDeclined: vi.fn()
    })
    await vi.waitFor(() =>
      expect(useAppStore.getState().unifiedTabsByWorktree[WORKTREE]).toEqual([
        expect.objectContaining({
          contentType: 'agent-session',
          executionHostId: 'runtime:server-1'
        })
      ])
    )
    // Admission's question is the plain one; create asks it again on its own.
    expect(mocks.createSupport.mock.calls[0]).toEqual([
      { worktree: `id:${WORKTREE}`, agent: 'claude' }
    ])
    expect(mocks.toastError).not.toHaveBeenCalled()
    launch?.cancel()
  })
})

// The same ask, of this machine's own runtime: a Claude account bound to WSL is one "no" it gives.
describe('a structured chat launch on this machine', () => {
  it('opens nothing when the launch is abandoned before this machine answers', async () => {
    let answer!: (support: { supported: boolean }) => void
    mocks.createSupport.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const onHostDeclined = vi.fn()

    const launch = beginStructuredAgentSessionProvisionalLaunch({
      plan: localPlan(),
      hooks: {},
      onHostDeclined
    })
    launch?.cancel()
    answer({ supported: false })

    await expect(launch?.settlement).resolves.toEqual({ kind: 'cancelled', sessionId: null })
    await expect(launch?.promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: false
    })
    expect(onHostDeclined).not.toHaveBeenCalled()
    expectNoChatCommitted()
  })

  // This machine has no connection to lose: the chat opens, and its own start reports a failure.
  it('opens the chat without a notice when this machine cannot answer the ask', async () => {
    mocks.createSupport.mockRejectedValue(new Error('runtime not ready'))
    const onHostDeclined = vi.fn()

    const launch = beginStructuredAgentSessionProvisionalLaunch({
      plan: localPlan(),
      hooks: {},
      onHostDeclined
    })

    await vi.waitFor(() =>
      expect(useAppStore.getState().unifiedTabsByWorktree[WORKTREE]).toHaveLength(1)
    )
    expect(onHostDeclined).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
    launch?.cancel()
  })
})

// Another terminal running the conversation: create would refuse it, so nothing opens first.
it('opens nothing for a resume the host refuses, leaving the one notice to its caller', async () => {
  mocks.createSupport.mockRejectedValue(
    Object.assign(new Error('agent_session_conflict'), {
      code: 'agent_session_conflict',
      data: {
        refusal: {
          code: 'agent_session_conflict',
          details: { reason: 'conversationHeldElsewhere' }
        }
      }
    })
  )
  const onHostDeclined = vi.fn()
  const launch = beginStructuredAgentSessionProvisionalLaunch({
    plan: pairedPlan({ executionHostId: 'local', resumeFrom: { providerSessionId: 'provider-1' } }),
    hooks: {},
    onHostDeclined
  })

  const settlement = await launch?.settlement
  expect(settlement).toMatchObject({
    kind: 'failed',
    error: { code: 'agent_session_conflict', refusal: { code: 'agent_session_conflict' } }
  })
  expect(settlement).not.toHaveProperty('notified')
  expect(mocks.createSupport).toHaveBeenCalledWith(
    expect.objectContaining({ resumeFrom: { providerSessionId: 'provider-1' } })
  )
  expect(onHostDeclined).not.toHaveBeenCalled()
  expect(mocks.toastError).not.toHaveBeenCalled()
  expectNoChatCommitted()
})

it('keeps an explicit chat and its prompt when its host declines startup', async () => {
  seedPairedServerWorkspace()
  mocks.createSupport.mockResolvedValue({ supported: false, reason: 'wsl' })
  const plan = adoptAgentSessionLaunchVerdict({ ...pairedPlan(), requestedSurface: 'chat' })
  const launch = beginStructuredAgentSessionProvisionalLaunch({ plan, hooks: {} })
  if (!launch?.tab) {
    throw new Error('An explicit chat must open before its host answers')
  }

  await expect(launch.settlement).resolves.toMatchObject({
    kind: 'failed',
    error: { code: 'structured_agent_session_unsupported' }
  })
  await expect(launch.promptDeliveryResult).resolves.toMatchObject({
    delivered: false,
    inComposer: true
  })
  expect(
    readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey(launch.tab.entityId)).text
  ).toBe('fix the flaky test')
  await vi.waitFor(() =>
    expect(useAppStore.getState().unifiedTabsByWorktree[WORKTREE]).toEqual([
      expect.objectContaining({
        contentType: 'agent-session',
        executionHostId: 'runtime:server-1'
      })
    ])
  )
})
