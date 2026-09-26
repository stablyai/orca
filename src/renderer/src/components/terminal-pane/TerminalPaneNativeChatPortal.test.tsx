// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalPaneController } from './use-terminal-pane-controller'

const mocks = vi.hoisted(
  (): {
    nativeChatViewProps: null | {
      isFocusedGroup: boolean
      contextMenuActions: { onClosePane: () => void }
    }
  } => ({ nativeChatViewProps: null })
)

vi.mock('@/store', () => ({
  useAppStore: (
    selector: (state: {
      agentStatusByPaneKey: Record<string, never>
      sleepingAgentSessionsByPaneKey: Record<string, never>
      paneForegroundAgentByPaneKey: Record<string, never>
    }) => unknown
  ) =>
    selector({
      agentStatusByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {},
      paneForegroundAgentByPaneKey: {}
    })
}))

vi.mock('../native-chat/NativeChatView', () => ({
  default: (props: {
    isFocusedGroup: boolean
    contextMenuActions: { onClosePane: () => void }
  }) => {
    mocks.nativeChatViewProps = props
    return <span data-focused-group={String(props.isFocusedGroup)} />
  }
}))

import { TerminalPaneNativeChatPortal } from './TerminalPaneNativeChatPortal'

afterEach(() => {
  cleanup()
  mocks.nativeChatViewProps = null
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
    container: portalContainer
  }
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
    readNativeChatTerminalScreen: vi.fn(),
    resolveAgentForLeaf: vi.fn(() => null),
    switchNativeChatToTerminal: vi.fn(),
    tabId: 'tab-1'
  } as unknown as TerminalPaneController
}
