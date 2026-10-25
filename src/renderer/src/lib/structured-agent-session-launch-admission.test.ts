// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { Worktree } from '../../../shared/worktree/types'

const mocks = vi.hoisted(() => ({
  createSupport: vi.fn(),
  toastInfo: vi.fn(),
  toastError: vi.fn(),
  launchAgentInNewTab: vi.fn(),
  hostPermission: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { info: mocks.toastInfo, error: mocks.toastError } }))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: mocks.launchAgentInNewTab }))
vi.mock('@/lib/ai-vault-session-resume-preparation', () => ({
  prepareAiVaultSessionForResume: async () => ({ sessionId: 'provider-1' })
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn(async (_target: unknown, method: string) => {
    if (method === 'agentSession.createSupport') {
      return mocks.createSupport()
    }
    return new Promise(() => undefined)
  })
}))

vi.mock('@/runtime/structured-chat-host-permission', () => ({
  readStructuredChatHostPermissionVerdict: mocks.hostPermission
}))
// Switch-on, main opens this machine's chats and its frames draw them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

import { useAppStore } from '@/store'
import { adoptAgentSessionLaunchVerdict } from './agent-session-launch-plan'
import { beginStructuredAgentSessionProvisionalLaunch } from './agent-session/structured-agent-session-provisional-tab'
import { beginDirectWorkItemStructuredLaunch } from './launch-work-item-direct-agent-routing'
import { getStructuredAgentLaunchStatus } from './structured-agent-session-launch-status'
import { getStructuredAgentSessionLaunchSelection } from './structured-agent-session-launch-options'
import { peekWebSessionFocusIntent } from '@/runtime/web-session-focus-intent'
import { LOCAL_ADMISSION_WAIT_MS } from './structured-agent-session-host-admission'
import { launchStructuredAgentFromNewTab } from './launch-agent-in-new-tab-structured-route'
import { structuredAgentSessionFocusOwner } from '@/runtime/structured-agent-session-owner'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs-drawn-from-main.test-fixture'

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

afterEach(() => main.close())

describe('a structured chat launch on a paired server', () => {
  beforeEach(seedPairedServerWorkspace)

  it('opens only the terminal when the server declines, keeping the workspace selected', async () => {
    mocks.createSupport.mockResolvedValue({ supported: false, reason: 'wsl' })
    const onHostDeclined = vi.fn(() => ({
      opened: true,
      promptDeliveryResult: Promise.resolve({ delivered: true, failureNotified: false })
    }))
    const reveal = vi.fn()

    const launch = beginStructuredAgentSessionProvisionalLaunch({
      plan: pairedPlan(),
      hooks: {},
      beforeOpen: reveal,
      onHostDeclined
    })

    expect(launch?.tab).toBeNull()
    expect(reveal).toHaveBeenCalledOnce()
    await expect(launch?.settlement).resolves.toEqual({ kind: 'terminal' })
    await expect(launch?.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    expect(onHostDeclined).toHaveBeenCalledOnce()
    expect(mocks.toastInfo).toHaveBeenCalledWith(expect.any(String), {
      description: expect.stringContaining("can't run")
    })
    expect(useAppStore.getState().activeWorktreeId).toBe(WORKTREE)
    expectNoChatCommitted()
  })

  it("opens a direct caller's terminal with the caller's own CLI arguments on a decline", async () => {
    mocks.createSupport.mockResolvedValue({ supported: false, reason: 'wsl' })
    mocks.launchAgentInNewTab.mockReturnValue({ surface: { kind: 'host-published' } })

    const result = beginDirectWorkItemStructuredLaunch({
      plan: pairedPlan(),
      primaryTabId: null,
      beforeOpen: vi.fn(),
      declinedTerminal: { agentArgs: '--model opus', launchSource: 'task_page' }
    })

    expect(result).toEqual({ completed: true, structuredLaunch: true, primaryTabId: null })
    await vi.waitFor(() => expect(mocks.launchAgentInNewTab).toHaveBeenCalledOnce())
    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'claude',
        worktreeId: WORKTREE,
        prompt: 'fix the flaky test',
        agentArgs: '--model opus',
        launchSource: 'task_page',
        agentSessionLaunchPlan: expect.objectContaining({ route: 'terminal-tui' })
      })
    )
    expectNoChatCommitted()
  })

  it('uses actual discovery outcome for both decline callers, preserving failed-refresh and shell fallback', async () => {
    const worktreeId = FLOATING_TERMINAL_WORKTREE_ID
    const plan = () => adoptAgentSessionLaunchVerdict({ ...localPlan(), worktreeId })
    useAppStore.getState().clearLocalDetectedAgents()
    const detect = vi.fn().mockResolvedValue([])
    const refresh = vi.fn().mockRejectedValue(new Error('failed'))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { preflight: { detectAgents: detect, refreshAgents: refresh } }
    })
    await useAppStore.getState().ensureNativeDetectedAgents()
    mocks.createSupport.mockResolvedValue({ supported: false })
    const openTerminal = vi.fn(() => ({ surface: { kind: 'host-published' as const } }))
    const declined = () =>
      launchStructuredAgentFromNewTab({ plan: plan(), worktreeId, openTerminal })
    await expect(declined()?.structuredSettlement).resolves.toMatchObject({ kind: 'failed' })
    const direct = () =>
      beginDirectWorkItemStructuredLaunch({
        plan: plan(),
        primaryTabId: null,
        beforeOpen: vi.fn(),
        declinedTerminal: { agentArgs: '--model opus', launchSource: 'task_page' }
      })
    direct()
    await vi.waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(2))
    // The action-first chat tab never swaps to a CLI terminal the host lacks.
    const actionFirst = beginStructuredAgentSessionProvisionalLaunch({
      plan: adoptAgentSessionLaunchVerdict({ ...plan(), prompt: '' }),
      hooks: {},
      focusIntent: { request: vi.fn(), cancel: vi.fn() }
    })
    expect(actionFirst?.tab).not.toBeNull()
    await expect(actionFirst?.settlement).resolves.toMatchObject({ kind: 'failed' })
    expect(openTerminal).not.toHaveBeenCalled()
    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
    await useAppStore.getState().refreshDetectedAgents(worktreeId)
    const inventory = useAppStore.getState().readLocalAgentInventory(worktreeId)
    expect(inventory).toEqual({ state: 'failed', ids: [] })
    await expect(declined()?.structuredSettlement).resolves.toEqual({ kind: 'terminal' })
    mocks.launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-terminal', tabId: 'fallback' }
    })
    direct()
    await vi.waitFor(() => expect(mocks.launchAgentInNewTab).toHaveBeenCalledOnce())
    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({ agentArgs: '--model opus', prompt: 'fix the flaky test' })
    )
    const seedShell = vi.fn(() => ({ opened: true }))
    await expect(
      launchStructuredAgentFromNewTab({
        plan: plan(),
        worktreeId,
        onHostDeclined: seedShell,
        openTerminal
      })?.structuredSettlement
    ).resolves.toEqual({ kind: 'terminal' })
    expect(seedShell).toHaveBeenCalledOnce()
  })

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

  // An older server ignores the chat's mode and would run Claude with its own bypass flag.
  it.each(['refused', 'unverified'] as const)(
    'starts nothing on a server whose permission verdict is %s, and says so once',
    async (kind) => {
      mocks.createSupport.mockResolvedValue({ supported: true })
      mocks.hostPermission.mockResolvedValue(
        kind === 'refused' ? { kind, hostMode: 'full-access' } : { kind }
      )

      const launch = beginStructuredAgentSessionProvisionalLaunch({
        plan: pairedPlan(),
        hooks: {},
        onHostDeclined: vi.fn()
      })
      const settlement = await launch?.settlement

      expect(mocks.hostPermission).toHaveBeenCalledWith(
        { kind: 'environment', environmentId: 'server-1' },
        'claude'
      )
      expect(settlement).toEqual(expect.objectContaining({ kind: 'failed', notified: true }))
      expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining('Claude'), {
        description: expect.stringMatching(
          kind === 'unverified' ? /confirm the host's permissions for Claude/ : /older Orca/
        )
      })
      expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
      expectNoChatCommitted()
    }
  )

  it('opens the chat on the server that admitted it', async () => {
    mocks.createSupport.mockResolvedValue({ supported: true })

    const launch = beginStructuredAgentSessionProvisionalLaunch({
      plan: pairedPlan(),
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
    launch?.cancel()
  })
})

// The same ask, of this machine's own runtime: a Claude account bound to WSL is one "no" it gives.
describe('a structured chat launch on this machine', () => {
  it('opens only the terminal when this machine declines, without a notice', async () => {
    mocks.createSupport.mockResolvedValue({ supported: false, reason: 'wsl' })
    const onHostDeclined = vi.fn(() => ({
      opened: true,
      promptDeliveryResult: Promise.resolve({ delivered: true, failureNotified: false })
    }))
    const reveal = vi.fn()

    const launch = beginStructuredAgentSessionProvisionalLaunch({
      plan: localPlan(),
      hooks: {},
      beforeOpen: reveal,
      onHostDeclined
    })

    expect(launch?.tab).toBeNull()
    expect(reveal).toHaveBeenCalledOnce()
    await expect(launch?.settlement).resolves.toEqual({ kind: 'terminal' })
    await expect(launch?.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    expect(onHostDeclined).toHaveBeenCalledExactlyOnceWith({ kind: 'local' }, undefined)
    expect(mocks.toastInfo).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
    expectNoChatCommitted()
  })

  it("opens a new agent tab's terminal with the typed prompt when the caller names none", async () => {
    mocks.createSupport.mockResolvedValue({ supported: false })
    mocks.launchAgentInNewTab.mockReturnValue({ surface: { kind: 'local-terminal', tabId: 't' } })

    const launch = beginStructuredAgentSessionProvisionalLaunch({
      plan: localPlan(),
      hooks: {},
      targetGroupId: 'group-1',
      declinedTerminal: { agentArgs: '--model opus' }
    })

    await expect(launch?.settlement).resolves.toEqual({ kind: 'terminal' })
    expect(mocks.launchAgentInNewTab).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        agent: 'claude',
        worktreeId: WORKTREE,
        groupId: 'group-1',
        prompt: 'fix the flaky test',
        agentArgs: '--model opus',
        agentSessionLaunchPlan: expect.objectContaining({ route: 'terminal-tui' })
      })
    )
    expectNoChatCommitted()
  })

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

  it('never asks this machine for a permission verdict: it applies every chat mode', async () => {
    mocks.createSupport.mockResolvedValue({ supported: true })
    const launch = beginStructuredAgentSessionProvisionalLaunch({
      plan: localPlan(),
      hooks: {},
      onHostDeclined: vi.fn()
    })
    await vi.waitFor(() =>
      expect(useAppStore.getState().unifiedTabsByWorktree[WORKTREE]).toHaveLength(1)
    )
    expect(mocks.hostPermission).not.toHaveBeenCalled()
    launch?.cancel()
  })

  it('opens the chat once this machine admits it', async () => {
    mocks.createSupport.mockResolvedValue({ supported: true })

    const launch = beginStructuredAgentSessionProvisionalLaunch({
      plan: localPlan(),
      hooks: {},
      onHostDeclined: vi.fn()
    })

    expect(useAppStore.getState().unifiedTabsByWorktree[WORKTREE] ?? []).toEqual([])
    await vi.waitFor(() =>
      expect(useAppStore.getState().unifiedTabsByWorktree[WORKTREE]).toEqual([
        expect.objectContaining({ contentType: 'agent-session', executionHostId: 'local' })
      ])
    )
    launch?.cancel()
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

  // Not resolvable yet is not a "no": the chat opens and its own create asks again, as before.
  it('opens the chat, not a terminal, when this machine cannot resolve a new workspace yet', async () => {
    mocks.createSupport.mockRejectedValue(new Error('selector_not_found'))
    const onHostDeclined = vi.fn()

    const launch = beginStructuredAgentSessionProvisionalLaunch({
      plan: localPlan(),
      hooks: {},
      onHostDeclined
    })

    await vi.waitFor(
      () => expect(useAppStore.getState().unifiedTabsByWorktree[WORKTREE]).toHaveLength(1),
      { timeout: 3_000 }
    )
    expect(onHostDeclined).not.toHaveBeenCalled()
    launch?.cancel()
  })

  // The click must never wait without end: past the bound the chat opens and reports for itself.
  it('opens the chat once the wait for this machine passes its bound', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      mocks.createSupport.mockReturnValue(new Promise(() => undefined))
      const onHostDeclined = vi.fn()

      const launch = beginStructuredAgentSessionProvisionalLaunch({
        plan: localPlan(),
        hooks: {},
        onHostDeclined
      })
      await vi.advanceTimersByTimeAsync(LOCAL_ADMISSION_WAIT_MS - 1)
      expect(useAppStore.getState().unifiedTabsByWorktree[WORKTREE] ?? []).toEqual([])

      await vi.advanceTimersByTimeAsync(1)
      expect(useAppStore.getState().unifiedTabsByWorktree[WORKTREE]).toHaveLength(1)
      expect(onHostDeclined).not.toHaveBeenCalled()
      expect(mocks.toastError).not.toHaveBeenCalled()
      launch?.cancel()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a paired server that cannot resolve a new workspace yet', () => {
  beforeEach(seedPairedServerWorkspace)

  it('keeps its terminal fallback, as before', async () => {
    mocks.createSupport.mockRejectedValue(new Error('selector_not_found'))
    const onHostDeclined = vi.fn(() => ({ opened: true }))

    const launch = beginStructuredAgentSessionProvisionalLaunch({
      plan: pairedPlan(),
      hooks: {},
      onHostDeclined
    })

    await expect(launch?.settlement).resolves.toEqual({ kind: 'terminal' })
    expect(onHostDeclined).toHaveBeenCalledOnce()
  })
})

it('keeps explicit refusal owned by admission and keeps an opened chat failure out of the menu', async () => {
  seedPairedServerWorkspace()
  for (const supported of [false, true]) {
    mocks.toastError.mockClear()
    mocks.createSupport.mockResolvedValue({ supported, reason: 'wsl' })
    const plan = adoptAgentSessionLaunchVerdict({ ...pairedPlan(), requestedSurface: 'chat' })
    if (supported) {
      mocks.createSupport
        .mockResolvedValueOnce({ supported: true })
        .mockResolvedValueOnce({ supported: false })
    }
    const onHostDeclined = vi.fn()
    const launch = beginStructuredAgentSessionProvisionalLaunch({ plan, hooks: {}, onHostDeclined })
    await expect(launch?.settlement).resolves.toMatchObject({ kind: 'failed' })
    expect(onHostDeclined).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledTimes(supported ? 0 : 1)
    if (!supported) {
      await expect(launch?.promptDeliveryResult).resolves.toMatchObject({
        delivered: false,
        failureNotified: true
      })
    }
  }
})
