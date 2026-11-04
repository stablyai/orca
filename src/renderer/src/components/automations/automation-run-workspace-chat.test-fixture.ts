import { expect, it, vi, type Mock } from 'vitest'
import type { AutomationRun } from '../../../../shared/automations-types'
import type { Tab } from '../../../../shared/tab-types'
import { makeUnifiedTab } from '@/store/slices/store-test-helpers'

export function installAutomationChatRunCases<T>({
  mocks,
  run,
  workspaceId,
  environmentId,
  groupId,
  seedChat,
  mount,
  open
}: {
  mocks: {
    state: Record<string, unknown>
    chatTabs: Tab[]
    activateTab: Mock
    rpc: Mock
    activate: Mock
    ownerActivate: Mock
    toastMessage: Mock
    toastError: Mock
  }
  run: AutomationRun
  workspaceId: string
  environmentId: string
  groupId: string
  seedChat: () => T
  mount: (input: T, run: AutomationRun) => Promise<unknown>
  open: (run: AutomationRun) => void
}): void {
  it('opens the recorded Chat on its owning paired server without creating a session or terminal', async () => {
    const input = seedChat()
    const recorded = {
      ...run,
      sessionKind: 'chat',
      chatSessionId: 'codex_recorded_chat',
      terminalSessionId: null,
      terminalPaneKey: null,
      terminalPtyId: null
    } satisfies AutomationRun
    await mount(input, recorded)
    open(recorded)
    await vi.waitFor(() =>
      expect(mocks.activateTab).toHaveBeenCalledWith('recorded-chat', { worktreeId: workspaceId })
    )
    expect(mocks.state.focusGroup).toHaveBeenCalledWith(workspaceId, groupId)
    expect(mocks.rpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: environmentId },
      'agentSession.reveal',
      { sessionId: 'codex_recorded_chat' },
      expect.any(Object)
    )
  })

  it('keeps Run Details output and opens the workspace when the recorded chat is gone', async () => {
    mocks.activateTab.mockClear()
    const input = seedChat()
    mocks.rpc.mockResolvedValue({ ok: false, refusal: { code: 'agent_session_identity_required' } })
    const recorded = {
      ...run,
      sessionKind: 'chat',
      chatSessionId: 'claude_missing',
      terminalSessionId: null,
      terminalPaneKey: null,
      terminalPtyId: null
    } satisfies AutomationRun
    await mount(input, recorded)
    open(recorded)
    await vi.waitFor(() =>
      expect(mocks.toastMessage).toHaveBeenCalledWith(
        expect.stringContaining('saved output remains')
      )
    )
    expect(mocks.activateTab).not.toHaveBeenCalled()
  })

  it.each(['terminal', 'chat'] as const)(
    'opens the actual published %s target even when delivery failed',
    async (kind) => {
      const input = seedChat()
      mocks.activateTab.mockClear()
      mocks.ownerActivate.mockClear()
      const failed = {
        ...run,
        status: 'dispatch_failed' as const,
        error: 'Prompt delivery could not be confirmed.',
        sessionKind: kind,
        ...(kind === 'chat'
          ? {
              chatSessionId: 'claude_published',
              terminalSessionId: null,
              terminalPaneKey: null,
              terminalPtyId: null
            }
          : {})
      }
      await mount(input, failed)
      open(failed)
      await vi.waitFor(() =>
        expect(kind === 'chat' ? mocks.activateTab : mocks.ownerActivate).toHaveBeenCalledOnce()
      )
      expect(mocks.activate).toHaveBeenCalledWith(workspaceId, {
        executionHostId: 'runtime:env-a',
        runtimeEnvironmentId: environmentId,
        providesInitialSurface: true
      })
    }
  )

  it('presents one automation fallback when duplicate exact activation clicks reject', async () => {
    const input = seedChat()
    mocks.chatTabs.push(
      makeUnifiedTab({
        id: 'recorded-chat',
        groupId: groupId,
        entityId: 'claude_published',
        worktreeId: workspaceId,
        executionHostId: `runtime:${environmentId}`,
        contentType: 'agent-session'
      })
    )
    mocks.state.focusGroup = vi.fn(() => {
      throw new Error('activation unavailable')
    })
    const recorded = {
      ...run,
      sessionKind: 'chat' as const,
      chatSessionId: 'claude_published',
      terminalSessionId: null,
      terminalPaneKey: null,
      terminalPtyId: null
    }
    await mount(input, recorded)
    open(recorded)
    open(recorded)
    await vi.waitFor(() =>
      expect(mocks.toastMessage).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining('saved output remains')
      )
    )
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(mocks.ownerActivate).not.toHaveBeenCalled()
  })
}
