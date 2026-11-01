// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AiVaultSession } from '../../../shared/ai-vault-types'
import type { Tab } from '../../../shared/tab-types'
import { useAiVaultSessionLaunchActions } from '@/components/right-sidebar/ai-vault-session-launch-actions'
import { useAiVaultOriginalPaneActions } from '@/components/right-sidebar/ai-vault-original-pane-actions'
import { reportCliChatResumeFailure } from '@/components/tab-bar/cli-chat-resume-feedback'
import AiVaultSessionDropLayer from '@/components/tab-group/AiVaultSessionDropLayer'
import { writeAiVaultSessionDragData } from './ai-vault-session-drag'
const transport = vi.hoisted(() => ({ rpc: vi.fn(), toast: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: transport.toast, success: vi.fn() } }))
vi.mock('@/runtime/runtime-rpc-client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  callRuntimeRpc: transport.rpc
}))
vi.mock('@/runtime/local-structured-session-tabs-sync/inventory-refresh', () => ({
  refreshLocalStructuredSessionWorktreeTabs: async () => undefined
}))
const workspace = 'workspace'
const session: AiVaultSession = {
  id: 'row',
  executionHostId: 'local',
  agent: 'codex',
  sessionId: 'provider',
  structuredSession: { workspaceId: workspace, sessionId: 'R' },
  title: 'History',
  cwd: '/repo',
  branch: null,
  model: null,
  filePath: '/fixture',
  codexHome: null,
  createdAt: null,
  updatedAt: null,
  modifiedAt: '2026-10-30',
  messageCount: 1,
  totalTokens: 0,
  previewMessages: [],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: '',
  subagent: null
}
function row(id: string, entityId: string): Tab {
  return {
    id,
    entityId,
    worktreeId: workspace,
    executionHostId: 'local',
    groupId: 'g',
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    label: 'Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}
function publish(tabs: Tab[]) {
  useAppStore.setState({
    unifiedTabsByWorktree: { [workspace]: tabs },
    groupsByWorktree: {
      [workspace]: [
        { id: 'g', worktreeId: workspace, activeTabId: null, tabOrder: tabs.map((tab) => tab.id) }
      ]
    },
    activeGroupIdByWorktree: { [workspace]: 'g' }
  })
}
beforeEach(() => {
  vi.clearAllMocks()
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({ activeWorktreeId: workspace, activeWorkspaceExecutionHostId: 'local' })
  publish([row('actual-S', 'S')])
  transport.rpc.mockImplementation(async (_host, method) =>
    method === 'orchestration.partyLocation'
      ? { location: { kind: 'chat', sessionId: 'S', worktreeId: workspace } }
      : { ok: true }
  )
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
const selected = () => useAppStore.getState().groupsByWorktree[workspace]?.[0]?.activeTabId
it.each(['history', 'jump', 'drop', 'cli-conflict'] as const)(
  'the real %s consumer reaches the common default adapter and actual selected row',
  async (consumer) => {
    if (consumer === 'history') {
      const hook = renderHook(() =>
        useAiVaultSessionLaunchActions({
          activeWorktree: null,
          activeWorktreeId: workspace,
          targetState: useAppStore.getState()
        })
      )
      act(() => hook.result.current.handleResume(session))
    } else if (consumer === 'jump') {
      publish([row('actual-R', 'R'), row('actual-S', 'S')])
      const hook = renderHook(() => useAiVaultOriginalPaneActions())
      await act(async () => {
        await hook.result.current.jumpToOriginalPane(session)
      })
    } else if (consumer === 'cli-conflict') {
      await reportCliChatResumeFailure(
        {
          tabId: 'cli',
          workspaceId: workspace,
          paneKey: 'cli:leaf',
          agent: 'codex',
          providerSessionId: 'provider',
          executionHostId: 'local'
        },
        Object.assign(new Error('conflict'), {
          refusal: {
            code: 'agent_session_conflict',
            details: {
              reason: 'conversationHeldElsewhere',
              owner: { sessionId: 'R', workspaceId: workspace }
            }
          }
        }),
        true,
        { kind: 'local' }
      )
    } else {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(0, 0, 400, 400)
      )
      const view = render(
        <>
          <div data-tab-group-body-id="g" data-worktree-id={workspace} />
          <AiVaultSessionDropLayer worktreeId={workspace} enabled />
        </>
      )
      const data = new DataTransfer()
      writeAiVaultSessionDragData(data, {
        agent: 'codex',
        sessionId: 'provider',
        structuredSession: session.structuredSession,
        title: 'History',
        command: ''
      })
      const event = new MouseEvent('drop', { bubbles: true, clientX: 200, clientY: 200 })
      Object.defineProperty(event, 'dataTransfer', { value: data })
      fireEvent(view.container.querySelector('[data-ai-vault-session-drop-layer]')!, event)
    }
    await waitFor(() => expect(selected()).toBe(consumer === 'jump' ? 'actual-R' : 'actual-S'))
    expect(transport.rpc.mock.calls.map((call) => call[1])).toEqual(
      consumer === 'jump'
        ? ['session.tabs.activate']
        : ['orchestration.partyLocation', 'session.tabs.activate']
    )
    expect(
      transport.rpc.mock.calls.every(
        (call) => JSON.stringify(call[0]) === JSON.stringify({ kind: 'local' })
      )
    ).toBe(true)
    expect(transport.toast).not.toHaveBeenCalled()
  }
)
