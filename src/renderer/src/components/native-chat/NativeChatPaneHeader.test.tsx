// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { createTabsSliceMockApi } from '@/store/slices/tabs-slice-test-harness'
import { makeFolderWorkspace } from '@/store/slices/worktrees-slice-test-fixtures'
import * as historyRequest from '../right-sidebar/ai-vault-panel-session-list-request'

const mocks = vi.hoisted(() => ({ launch: vi.fn(), resume: vi.fn(), close: vi.fn() }))
vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  return { useAppStore: createTestStore() }
})
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: mocks.launch }))
vi.mock('@/lib/workspace-tab-commands', () => ({ dispatchWorkspaceTabCommand: mocks.close }))
vi.mock('../tab-bar/native-chat-cli-fork-run', () => ({
  runNativeChatCliFork: mocks.resume,
  useNativeChatCliForkPending: () => false
}))

import { NativeChatPaneHeader } from './NativeChatPaneHeader'

const fullRequest = vi.spyOn(historyRequest, 'resolveAiVaultPanelSessionListRequest')
const testWindow = window
const api = createTabsSliceMockApi()
vi.stubGlobal('window', testWindow)
Object.assign(window, { api })
afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    folderWorkspaces: [makeFolderWorkspace({ id: 'workspace', folderPath: '/repo' })]
  })
})

function renderHeader() {
  const source = useAppStore.getState().createUnifiedTab('folder:workspace', 'agent-session', {
    agentSessionAgent: 'codex',
    executionHostId: 'runtime:remote-host'
  })
  render(
    <TooltipProvider>
      <NativeChatPaneHeader
        tabId={source.id}
        worktreeId={source.worktreeId}
        groupId={source.groupId}
        nativeChat={{ sessionId: source.entityId, agent: 'codex' }}
        focused
        colorScheme="dark"
      />
    </TooltipProvider>
  )
  return source
}

it('offers the terminal header action order and targets Resume and Close at the displayed chat', () => {
  const source = renderHeader()
  expect(screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
    'Continue with Terminal Agent',
    'Split Chat Right',
    'Close tab'
  ])
  const folder = useAppStore.getState().folderWorkspaces[0]
  act(() => useAppStore.setState({ folderWorkspaces: [{ ...folder, executionHostId: 'ssh:dev' }] }))
  expect(screen.queryByRole('button', { name: 'Continue with Terminal Agent' })).toBeNull()
  act(() => useAppStore.setState({ folderWorkspaces: [folder] }))
  expect(fullRequest).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Continue with Terminal Agent' }))
  expect(fullRequest).toHaveBeenCalledTimes(1)
  expect(mocks.resume).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      subject: expect.objectContaining({
        sessionId: source.entityId,
        request: { scopePaths: ['/repo'], executionHostScope: 'local', sessionLimit: 250 }
      }),
      tab: { id: source.id, worktreeId: source.worktreeId },
      agent: 'codex'
    })
  )
  fireEvent.click(screen.getByRole('button', { name: 'Close tab' }))
  expect(mocks.close).toHaveBeenCalledExactlyOnceWith({
    type: 'close',
    target: { kind: 'tab', worktreeId: source.worktreeId, tabId: source.id }
  })
})

it('Split from the header keeps the source and opens a fresh chat on the same host', () => {
  const source = renderHeader()
  mocks.launch.mockImplementation((args: { worktreeId: string; groupId: string }) => {
    useAppStore.getState().createUnifiedTab(args.worktreeId, 'agent-session', {
      targetGroupId: args.groupId,
      agentSessionAgent: 'codex',
      executionHostId: 'runtime:remote-host'
    })
    return { surface: { kind: 'local-chat', tabId: 'fresh-chat' } }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Split Chat Right' }))
  const state = useAppStore.getState()
  const destination = state.activeGroupIdByWorktree[source.worktreeId]
  expect(destination).not.toBe(source.groupId)
  expect(mocks.launch).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      agent: 'codex',
      requestedSurface: 'chat',
      selectedExecutionHostId: source.executionHostId,
      worktreeId: source.worktreeId,
      groupId: destination,
      focusIntent: expect.objectContaining({ cancel: expect.any(Function) })
    })
  )
  const tabs = state.unifiedTabsByWorktree[source.worktreeId]
  expect(tabs.find((tab) => tab.id === source.id)).toEqual(source)
  expect(tabs).toHaveLength(2)
  expect(tabs.find((tab) => tab.groupId === destination)?.entityId).not.toBe(source.entityId)
})
