// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createSupport: vi.fn(),
  toastInfo: vi.fn(),
  toastError: vi.fn(),
  launchAgentInNewTab: vi.fn()
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

import { useAppStore } from '@/store'
import { adoptAgentSessionLaunchVerdict } from './agent-session-launch-plan'
import { beginStructuredAgentSessionProvisionalLaunch } from './structured-agent-session-provisional-tab'
import { beginDirectWorkItemStructuredLaunch } from './launch-work-item-direct-agent-routing'
import type { AiVaultSession } from '../../../shared/ai-vault-types'
import { resumeAiVaultSessionInNewChat } from '@/components/right-sidebar/ai-vault-session-resume-in-chat-launch'
import { getStructuredAgentLaunchStatus } from './structured-agent-session-launch-status'
import { getStructuredAgentSessionLaunchSelection } from './structured-agent-session-launch-options'
import { peekWebSessionFocusIntent } from '@/runtime/web-session-focus-intent'

const WORKTREE = 'repo-1::/srv/app'
const INITIAL_SETTINGS = useAppStore.getState().settings

function pairedPlan(overrides: { resumeFrom?: { providerSessionId: string } } = {}) {
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

/** Nothing of a chat exists on this machine: no tab, launch, record, queued prompt or intent. */
function expectNoChatCommitted(): void {
  expect(useAppStore.getState().unifiedTabsByWorktree[WORKTREE] ?? []).toEqual([])
  expect(getStructuredAgentLaunchStatus(WORKTREE, 'claude')).toBe('idle')
  expect(Object.keys(localStorage)).toEqual([])
  expect(peekWebSessionFocusIntent({ environmentId: 'server-1' }, WORKTREE)).toBeNull()
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useAppStore.setState({
    activeWorktreeId: WORKTREE,
    activeWorkspaceExecutionHostId: null,
    unifiedTabsByWorktree: {},
    settings: INITIAL_SETTINGS
  })
})

describe('a structured chat launch on a paired server', () => {
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

  it('says once that the server cannot be reached when a vault resume needs it', async () => {
    mocks.createSupport.mockRejectedValue(new Error('connection lost'))
    // The vault names no host; the workspace's owner, the paired server, is resolved for it.
    useAppStore.setState({ activeWorkspaceExecutionHostId: 'runtime:server-1' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resume reads only the id fields the preparation mock ignores.
    const session = { id: 'vault-1', sessionId: 'provider-1' } as AiVaultSession

    await resumeAiVaultSessionInNewChat(session, 'claude', WORKTREE, 'resume-click')

    await vi.waitFor(() => expect(mocks.toastError).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mocks.toastError).toHaveBeenCalledOnce()
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringContaining('Could not reach'),
      expect.anything()
    )
    expectNoChatCommitted()
  })

  it('fails a resume the server declines, since a resume has no terminal equivalent', async () => {
    mocks.createSupport.mockResolvedValue({ supported: false })
    const onHostDeclined = vi.fn()

    const launch = beginStructuredAgentSessionProvisionalLaunch({
      plan: pairedPlan({ resumeFrom: { providerSessionId: 'provider-1' } }),
      hooks: {},
      onHostDeclined
    })

    await expect(launch?.settlement).resolves.toMatchObject({ kind: 'failed' })
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
