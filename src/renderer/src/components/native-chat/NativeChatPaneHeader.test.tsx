import { ConfirmationDialogProvider } from '@/components/confirmation-dialog'
// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render as renderWithConfirmation,
  screen,
  waitFor
} from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { RetainedPaneHost } from '../tab-group/RetainedPaneHost'
import { useAppStore } from '@/store'
import { createTabsSliceMockApi } from '@/store/slices/tabs-slice-test-harness'
import { makeFolderWorkspace } from '@/store/slices/worktrees-slice-test-fixtures'
import * as historyRequest from '../right-sidebar/ai-vault-panel-session-list-request'

function render(ui: React.ReactNode) {
  return renderWithConfirmation(ui, { wrapper: ConfirmationDialogProvider })
}

vi.mock('@/runtime/structured-agent-session-client', async (original) => ({
  ...(await original<object>()),
  supportsInPlaceSwitch: async () => false
}))

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

import { NativeChatPaneHeader, type NativeChatHeaderHandOff } from './NativeChatPaneHeader'

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

function renderHeader(
  handOff?: NativeChatHeaderHandOff,
  focused = true,
  agent: 'codex' | 'omp' = 'codex'
) {
  const source = useAppStore.getState().createUnifiedTab('folder:workspace', 'agent-session', {
    agentSessionAgent: agent,
    executionHostId: 'runtime:remote-host'
  })
  render(
    <TooltipProvider>
      <NativeChatPaneHeader
        tabId={source.id}
        worktreeId={source.worktreeId}
        groupId={source.groupId}
        nativeChat={{ sessionId: source.entityId, agent }}
        focused={focused}
        colorScheme="dark"
        handOff={handOff}
      />
    </TooltipProvider>
  )
  return source
}

it('keeps the switch hit target stable while its inactive pane gains focus during one press', () => {
  const source = useAppStore.getState().createUnifiedTab('folder:workspace', 'agent-session', {
    agentSessionAgent: 'claude',
    executionHostId: 'runtime:remote-host'
  })
  const otherGroup = useAppStore
    .getState()
    .createEmptySplitGroup(source.worktreeId, source.groupId, 'right')
  if (otherGroup === null) {
    throw new Error('Expected the sibling split group to be created')
  }
  const switchToCli = vi.fn()
  const handOff = { open: vi.fn(), disabled: false }
  function FocusableHeader() {
    const focused = useAppStore(
      (state) => state.activeGroupIdByWorktree[source.worktreeId] === source.groupId
    )
    return (
      <TooltipProvider>
        <RetainedPaneHost
          groupId={source.groupId}
          isVisible
          onFocusOwningGroup={(groupId) =>
            useAppStore.getState().focusGroup(source.worktreeId, groupId)
          }
        >
          <NativeChatPaneHeader
            tabId={source.id}
            worktreeId={source.worktreeId}
            groupId={source.groupId}
            nativeChat={{ sessionId: source.entityId, agent: 'claude' }}
            focused={focused}
            colorScheme="dark"
            handOff={handOff}
            topRightAction={<Button onClick={switchToCli}>Switch to CLI</Button>}
          />
        </RetainedPaneHost>
      </TooltipProvider>
    )
  }
  const view = render(<FocusableHeader />)
  const switchButton = screen.getByRole('button', { name: 'Switch to CLI' })
  const row = switchButton.closest('.pane-title-actions')!
  const members = Array.from(row.children)
  const handOffButton = row.querySelector<HTMLButtonElement>(
    'button[aria-label="Hand Off to Another Agent"]'
  )!
  expect(useAppStore.getState().activeGroupIdByWorktree[source.worktreeId]).toBe(otherGroup)
  expect(handOffButton).not.toBeNull()
  expect(getComputedStyle(handOffButton).visibility).toBe('hidden')
  expect(screen.queryByRole('button', { name: 'Hand Off to Another Agent' })).toBeNull()
  expect(switchButton.hasAttribute('disabled')).toBe(false)

  fireEvent.pointerDown(switchButton)
  expect(useAppStore.getState().activeGroupIdByWorktree[source.worktreeId]).toBe(source.groupId)
  expect(Array.from(row.children)).toEqual(members)
  expect(screen.getByRole('button', { name: 'Switch to CLI' })).toBe(switchButton)
  expect(screen.getByRole('button', { name: 'Hand Off to Another Agent' })).toBe(handOffButton)
  expect(getComputedStyle(handOffButton).visibility).toBe('visible')
  fireEvent.focus(switchButton)
  fireEvent.pointerUp(switchButton)
  fireEvent.click(switchButton)
  expect(switchToCli).toHaveBeenCalledOnce()
  expect(handOff.open).not.toHaveBeenCalled()

  act(() => useAppStore.getState().focusGroup(source.worktreeId, otherGroup))
  expect(Array.from(row.children)).toEqual(members)
  expect(getComputedStyle(handOffButton).visibility).toBe('hidden')
  expect(screen.queryByRole('button', { name: 'Hand Off to Another Agent' })).toBeNull()
  view.unmount()
})

it('offers the terminal header action order and targets Resume and Close at the displayed chat', async () => {
  // The copy button is for an agent the top-right control can't switch in place.
  const source = renderHeader(undefined, true, 'omp')
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
  await waitFor(() =>
    expect(mocks.resume).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        subject: expect.objectContaining({
          sessionId: source.entityId,
          request: { scopePaths: ['/repo'], executionHostScope: 'local', sessionLimit: 250 }
        }),
        tab: { id: source.id, worktreeId: source.worktreeId },
        agent: 'omp',
        queuedMessage:
          'A copy of this OMP conversation opens in a new terminal. The original chat stays open.'
      })
    )
  )
  fireEvent.click(screen.getByRole('button', { name: 'Close tab' }))
  expect(mocks.close).toHaveBeenCalledExactlyOnceWith({
    type: 'close',
    target: { kind: 'tab', worktreeId: source.worktreeId, tabId: source.id }
  })
})
