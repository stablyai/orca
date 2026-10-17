// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'

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

import { useAppStore } from '@/store'
import { adoptAgentSessionLaunchVerdict } from './agent-session-launch-plan'
import { beginStructuredAgentSessionProvisionalLaunch } from './structured-agent-session-provisional-tab'
import { beginDirectWorkItemStructuredLaunch } from './launch-work-item-direct-agent-routing'
import { getStructuredAgentLaunchStatus } from './structured-agent-session-launch-status'
import { getStructuredAgentSessionLaunchSelection } from './structured-agent-session-launch-options'
import { peekWebSessionFocusIntent } from '@/runtime/web-session-focus-intent'
import { LOCAL_ADMISSION_WAIT_MS } from './structured-agent-session-host-admission'
import { LEAF_ID, makeSnapshot } from '@/runtime/web-session-tabs-sync-test-harness'
import { applyFreshWebSessionTabsSnapshot } from '@/runtime/web-session-tabs-sync/snapshot-api'
import { makeOpenFile } from '@/store/slices/store-test-helpers'
import type { Tab } from '../../../shared/tab-types'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { structuredAgentSessionFocusOwner } from '@/runtime/structured-agent-session-owner'

const WORKTREE = 'repo-1::/srv/app'
const INITIAL_STATE = useAppStore.getState()

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

function acceptedChatSnapshot(chat: Tab, siblings: RuntimeMobileSessionTabsResult['tabs'] = []) {
  return makeSnapshot(
    [
      {
        type: 'agent-session',
        id: `agent-session:${chat.entityId}`,
        sessionId: chat.entityId,
        agent: 'claude',
        title: 'Claude Chat',
        isActive: true
      },
      ...siblings
    ],
    {
      worktree: WORKTREE,
      publicationEpoch: chat.entityId,
      activeTabId: `agent-session:${chat.entityId}`,
      activeTabType: 'agent-session'
    }
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.hostPermission.mockResolvedValue({ kind: 'allowed' })
  localStorage.clear()
  useAppStore.setState(INITIAL_STATE, true)
  useAppStore.setState({
    activeWorktreeId: WORKTREE,
    activeWorkspaceExecutionHostId: null,
    unifiedTabsByWorktree: {},
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    settings: INITIAL_STATE.settings
  })
})

describe('a structured chat launch on a paired server', () => {
  it.each(['setup', 'file', null])(
    'publishes automatic chat without replacing a choice during admission: %s',
    async (pick) => {
      let answer!: (support: { supported: boolean }) => void
      mocks.createSupport.mockReturnValue(new Promise((resolve) => (answer = resolve)))
      const launch = beginStructuredAgentSessionProvisionalLaunch({
        plan: pairedPlan(),
        hooks: {},
        recordFocus: false
      })
      const setup = pick === 'setup' ? useAppStore.getState().createTab(WORKTREE) : null
      const file =
        pick === 'file' ? makeOpenFile({ id: '/srv/app/index.ts', worktreeId: WORKTREE }) : null
      const fileId = file ? useAppStore.getState().openFile(file) : null
      answer({ supported: true })
      await vi.waitFor(() =>
        expect(getStructuredAgentLaunchStatus(WORKTREE, 'claude')).toBe('pending')
      )
      const state = useAppStore.getState()
      expect(state.unifiedTabsByWorktree[WORKTREE]).toHaveLength(pick ? 2 : 1)
      const chat = state.unifiedTabsByWorktree[WORKTREE]!.find(
        (tab) => tab.contentType === 'agent-session'
      )!
      const fileTab = state.unifiedTabsByWorktree[WORKTREE]!.find(
        (tab) => tab.contentType === 'editor' && tab.entityId === fileId
      )
      const selected = setup?.id ?? fileTab?.id ?? chat.id
      const selectedType = setup ? 'terminal' : fileId ? 'editor' : 'agent-session'
      expect(chat.lastFocusedAt).toBeUndefined()
      expect(peekWebSessionFocusIntent({ environmentId: 'server-1' }, WORKTREE)).toBeNull()
      expect(state.activeGroupIdByWorktree[WORKTREE]).toBe(chat.groupId)
      expect(state.groupsByWorktree[WORKTREE]?.[0]?.activeTabId).toBe(selected)
      expect(state.activeTabType).toBe(selectedType)
      expect(state.activeTabTypeByWorktree[WORKTREE]).toBe(selectedType)
      expect(fileId ? state.activeFileId : state.activeTabId).toBe(fileId ?? setup?.id ?? null)
      const siblings: RuntimeMobileSessionTabsResult['tabs'] = []
      if (setup) {
        siblings.push({
          type: 'terminal',
          id: `${setup.id}::${LEAF_ID}`,
          parentTabId: setup.id,
          leafId: LEAF_ID,
          title: 'Setup',
          terminal: 'term_setup',
          status: 'ready',
          isActive: false
        })
      }
      if (file) {
        siblings.push({
          type: 'file',
          mode: 'edit',
          id: fileTab!.id,
          title: 'index.ts',
          filePath: file.filePath,
          relativePath: file.relativePath,
          language: file.language,
          isDirty: file.isDirty,
          isActive: false
        })
      }
      const snapshot = acceptedChatSnapshot(chat, siblings)
      useAppStore.setState(applyFreshWebSessionTabsSnapshot(state, snapshot, 'server-1'))
      const accepted = useAppStore.getState()
      const acceptedSelection = setup ? toWebTerminalSurfaceTabId(setup.id) : selected
      expect(accepted.activeGroupIdByWorktree[WORKTREE]).toBe(chat.groupId)
      expect(accepted.groupsByWorktree[WORKTREE]?.[0]?.activeTabId).toBe(acceptedSelection)
      expect(accepted.activeTabType).toBe(selectedType)
      expect(accepted.activeTabTypeByWorktree[WORKTREE]).toBe(selectedType)
      expect(fileId ? accepted.activeFileId : accepted.activeTabId).toBe(
        fileId ?? acceptedSelection
      )
      expect(
        fileId
          ? accepted.activeFileIdByWorktree[WORKTREE]
          : accepted.activeTabIdByWorktree[WORKTREE]
      ).toBe(fileId ?? acceptedSelection)
      expect(
        accepted.unifiedTabsByWorktree[WORKTREE]?.find((tab) => tab.id === chat.id)?.lastFocusedAt
      ).toBeUndefined()
      expect(peekWebSessionFocusIntent({ environmentId: 'server-1' }, WORKTREE)).toBeNull()
      launch?.cancel()
    }
  )
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
    expect(mocks.toastInfo).toHaveBeenCalledOnce()
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
      expect(mocks.toastError).toHaveBeenCalledTimes(1)
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
    expect(useAppStore.getState().unifiedTabsByWorktree[WORKTREE]?.[0]?.lastFocusedAt).toBeTypeOf(
      'number'
    )
    expect(peekWebSessionFocusIntent({ environmentId: 'server-1' }, WORKTREE)).not.toBeNull()
    const state = useAppStore.getState()
    const chat = state.unifiedTabsByWorktree[WORKTREE]![0]!
    useAppStore.setState(
      applyFreshWebSessionTabsSnapshot(state, acceptedChatSnapshot(chat), 'server-1')
    )
    const accepted = useAppStore.getState()
    expect(accepted.groupsByWorktree[WORKTREE]?.[0]?.activeTabId).toBe(chat.id)
    expect(accepted.activeTabId).toBe(chat.id)
    expect(accepted.activeTabType).toBe('agent-session')
    expect(accepted.unifiedTabsByWorktree[WORKTREE]?.[0]?.lastFocusedAt).toBe(chat.lastFocusedAt)
    expect(peekWebSessionFocusIntent({ environmentId: 'server-1' }, WORKTREE)).toBeNull()
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
    expect(onHostDeclined).toHaveBeenCalledExactlyOnceWith({ kind: 'local' })
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
