// @vitest-environment happy-dom

import { cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatContextMenuActions } from '../native-chat/use-native-chat-context-menu'
import type { PaneAgentSessionIdState } from './pane-agent-session-id'
import { NativeChatPaneMenuItems } from '../native-chat/NativeChatPaneMenuItems'
import { useTerminalPaneContextMenu } from './use-terminal-pane-context-menu'
import { createPane, createManager } from './pty-connection-test-pane-fixtures'
import { mockPanePtyArgs } from './pty-connection-test-connect-mock-pane'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { TerminalPaneController } from './use-terminal-pane-controller'

type NativeChatPortalMenuActions = Omit<NativeChatContextMenuActions, 'onPaste'>

const mocks = vi.hoisted(
  (): {
    state: PaneAgentSessionIdState
    nativeChatViewProps: null | {
      isFocusedGroup: boolean
      contextMenuActions: NativeChatPortalMenuActions
    }
  } => ({
    nativeChatViewProps: null,
    state: {
      agentStatusByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {},
      paneForegroundAgentByPaneKey: {}
    }
  })
)

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: PaneAgentSessionIdState) => unknown) => selector(mocks.state),
    { getState: () => mocks.state }
  )
}))
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: ({
    children,
    onSelect
  }: {
    children?: React.ReactNode
    onSelect?: () => void
  }) => <button onClick={onSelect}>{children}</button>,
  DropdownMenuSeparator: () => null,
  DropdownMenuShortcut: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>
}))

vi.mock('../native-chat/NativeChatView', () => ({
  default: (props: {
    isFocusedGroup: boolean
    contextMenuActions: NativeChatPortalMenuActions
  }) => {
    mocks.nativeChatViewProps = props
    return (
      <>
        <span data-focused-group={String(props.isFocusedGroup)} />
        <NativeChatPaneMenuItems actions={props.contextMenuActions} />
      </>
    )
  }
}))

import { TerminalPaneNativeChatPortal } from './TerminalPaneNativeChatPortal'

afterEach(() => {
  cleanup()
  mocks.nativeChatViewProps = null
  mocks.state = {
    agentStatusByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    paneForegroundAgentByPaneKey: {}
  }
})

describe('TerminalPaneNativeChatPortal', () => {
  it('targets the restored chat pane when its sibling is active', () => {
    const portalContainer = document.createElement('div')
    const controller = makeController(portalContainer, { activePaneIsChatLeaf: false })
    if (!controller.chatPane) {
      throw new Error('fixture must have a chat pane')
    }
    controller.chatPane.id = 42
    controller.contextMenu.onClosePane = vi.fn()
    render(<TerminalPaneNativeChatPortal controller={controller} />)
    mocks.nativeChatViewProps?.contextMenuActions.onClosePane()
    expect(controller.contextMenu.runForPane).toHaveBeenCalledWith(
      42,
      controller.contextMenu.onClosePane
    )
  })

  it("runs the chat pane's Copy Context and Clear Pane Title, offering the latter only when titled", () => {
    const portalContainer = document.createElement('div')
    const controller = makeController(portalContainer, { activePaneIsChatLeaf: false })
    render(<TerminalPaneNativeChatPortal controller={controller} />)
    expect(mocks.nativeChatViewProps?.contextMenuActions.canClearPaneTitle).toBe(false)

    controller.paneTitles = { 1: 'Build agent' }
    controller.contextMenu.onCopyAgentSessionContext = vi.fn()
    controller.contextMenu.onClearPaneTitle = vi.fn()
    render(<TerminalPaneNativeChatPortal controller={controller} />)
    const actions = mocks.nativeChatViewProps?.contextMenuActions
    expect(actions?.canClearPaneTitle).toBe(true)
    actions?.onCopyAgentSessionContext()
    actions?.onClearPaneTitle()
    expect(controller.contextMenu.runForPane).toHaveBeenCalledWith(
      1,
      controller.contextMenu.onCopyAgentSessionContext
    )
    expect(controller.contextMenu.runForPane).toHaveBeenCalledWith(
      1,
      controller.contextMenu.onClearPaneTitle
    )
  })

  it('renders and copies the retained provider ID from an exited pane through its real action', async () => {
    const portalContainer = document.createElement('div')
    document.body.appendChild(portalContainer)
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    mocks.state = {
      agentStatusByPaneKey: {
        [paneKey]: {
          paneKey,
          state: 'done',
          agentType: 'claude',
          prompt: '',
          updatedAt: 1,
          stateStartedAt: 1,
          stateHistory: [],
          providerSession: { key: 'session_id', id: 'retained-provider-session' }
        }
      },
      sleepingAgentSessionsByPaneKey: {},
      paneForegroundAgentByPaneKey: { [paneKey]: { agent: null, shellForeground: true } }
    }
    const write = vi.fn().mockResolvedValue(undefined)
    Object.assign(window, { api: { ui: { writeTerminalClipboardText: write } } })
    const mockPane = createPane(1)
    Object.assign(mockPane.terminal, { focus: vi.fn() })
    const mockManager = createManager(1)
    mockManager.getPanes.mockReturnValue([mockPane])
    mockManager.getActivePane.mockReturnValue(mockPane)
    const state = createInitialStoreState(() => state)
    const [, manager] = mockPanePtyArgs(
      mockPane,
      mockManager,
      buildPaneConnectionDeps(() => state)
    )
    const { result } = renderHook(() =>
      useTerminalPaneContextMenu({
        managerRef: { current: manager },
        paneTransportsRef: { current: new Map() },
        paneCwdRef: { current: new Map() },
        containerRef: { current: null },
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        groupId: null,
        fallbackCwd: '/tmp',
        toggleExpandPane: vi.fn(),
        onRequestClosePane: vi.fn(),
        onClearPaneScrollback: vi.fn(),
        onSetTitle: vi.fn(),
        onClearPaneTitle: vi.fn(),
        onPasteError: vi.fn(),
        onAgentSessionForkReady: vi.fn(),
        onAgentSessionContinuationReady: vi.fn(),
        forceBracketedMultilineTextPaste: false,
        rightClickToPaste: false
      })
    )
    const controller = makeController(portalContainer, { activePaneIsChatLeaf: true })
    controller.contextMenu = result.current
    render(<TerminalPaneNativeChatPortal controller={controller} />)
    const copy = [...portalContainer.querySelectorAll('button')].find(
      (button) => button.textContent === 'Copy Session ID'
    )
    if (!copy) {
      throw new Error('missing retained session action')
    }
    fireEvent.click(copy)
    await waitFor(() => expect(write).toHaveBeenCalledWith('retained-provider-session'))
    portalContainer.remove()
  })

  it('only gives the composer focus ownership to the active split leaf', () => {
    const portalContainer = document.createElement('div')
    document.body.appendChild(portalContainer)
    const view = render(
      <TerminalPaneNativeChatPortal
        controller={makeController(portalContainer, { activePaneIsChatLeaf: false })}
      />
    )

    expect(mocks.nativeChatViewProps?.isFocusedGroup).toBe(false)

    view.rerender(
      <TerminalPaneNativeChatPortal
        controller={makeController(portalContainer, { activePaneIsChatLeaf: true })}
      />
    )
    expect(mocks.nativeChatViewProps?.isFocusedGroup).toBe(true)

    portalContainer.remove()
  })
})

function makeController(
  portalContainer: HTMLElement,
  overrides: { activePaneIsChatLeaf: boolean }
): TerminalPaneController {
  const chatPane = {
    id: 1,
    leafId: '11111111-1111-4111-8111-111111111111',
    container: portalContainer,
    terminal: { element: document.createElement('div'), focus: vi.fn() }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the portal reads only the controller fields this fixture sets.
  return {
    chatPane,
    chatPaneLaunchAgent: null,
    chatPaneOwnsTabWideLaunchDraft: false,
    chatPanePtyId: null,
    chatPaneResolvedAgent: null,
    contextMenu: {
      runForPane: vi.fn()
    },
    effectiveChatViewMode: true,
    expandedPaneId: null,
    activePaneIsChatLeaf: overrides.activePaneIsChatLeaf,
    isActive: true,
    isRendererVisible: true,
    managedPanes: [chatPane, { id: 2, leafId: '22222222-2222-4222-8222-222222222222' }],
    paneTitles: {},
    readNativeChatTerminalScreen: vi.fn(),
    resolveAgentForLeaf: vi.fn(() => null),
    switchNativeChatToTerminal: vi.fn(),
    tabId: 'tab-1'
  } as unknown as TerminalPaneController
}
