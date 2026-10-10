// @vitest-environment happy-dom
import { useEffect, useRef } from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state = {
    activeWorktreeId: 'wt-active',
    rightSidebarOpen: true,
    sidebarOpen: true,
    groupsByWorktree: {}
  }
  const useAppStore = (selector: (current: typeof state) => unknown): unknown => selector(state)
  useAppStore.getState = () => state
  return { capture: vi.fn(), deliver: vi.fn(), monacoSawDrop: vi.fn(), useAppStore }
})
vi.mock('@/store', () => ({ useAppStore: mocks.useAppStore }))
vi.mock('../../store', () => ({ useAppStore: mocks.useAppStore }))
vi.mock('../editor/editor-dropped-file-open', () => ({
  captureEditorFileDropOpen: mocks.capture,
  editorGroupStillExists: () => true
}))
vi.mock('../tab-bar/TabBar', () => ({ default: () => null }))
vi.mock('../tab-bar/TabBarQuickCommandsButton', () => ({ TabBarQuickCommandsButton: () => null }))
vi.mock('@/lib/pane-manager/client-hosted-browser-row-state', () => ({
  useClientHostedBrowserRows: () => []
}))
vi.mock('./useTabGroupWorkspaceModel', () => ({
  useTabGroupWorkspaceModel: () => ({
    activeTab: { id: 'tab-1', entityId: 'file-1', contentType: 'editor' },
    agentSessionItems: [],
    browserItems: [],
    commands: { focusGroup: () => undefined },
    editorItems: [],
    tabBarOrder: [],
    terminalTabs: [],
    groupTabs: [],
    expandedPaneByTabId: {}
  })
}))
// Stands in for Monaco, which listens for drops on its own DOM node.
vi.mock('../editor/EditorPanel', () => ({
  default: function FakeMonaco() {
    const ref = useRef<HTMLDivElement>(null)
    useEffect(() => {
      const node = ref.current
      node?.addEventListener('drop', mocks.monacoSawDrop)
      node?.addEventListener('dragover', mocks.monacoSawDrop)
      return () => {
        node?.removeEventListener('drop', mocks.monacoSawDrop)
        node?.removeEventListener('dragover', mocks.monacoSawDrop)
      }
    }, [])
    return (
      <div ref={ref} data-testid="monaco">
        <textarea data-testid="monaco-input" />
      </div>
    )
  }
}))

import TabGroupPanel from './TabGroupPanel'

function drag(target: Element, type: 'dragover' | 'drop'): Event {
  const transfer = { types: ['Files'], files: [new File(['x'], 'dropped.md')], dropEffect: 'move' }
  const event = new Event(type, { bubbles: true, cancelable: true, composed: true })
  Object.defineProperty(event, 'dataTransfer', { value: transfer })
  Object.defineProperty(event, 'isTrusted', { value: true })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

beforeEach(() => {
  mocks.capture.mockImplementation(() => mocks.deliver)
  vi.stubGlobal('api', {
    fs: {
      getPathForFile: (file: File) => `/Users/me/${file.name}`,
      prepareDroppedPaths: async ({ paths }: { paths: string[] }) => ({ paths, failures: [] })
    }
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('TabGroupPanel editor area OS file drops', () => {
  it("opens a file dropped on the editor in this group's worktree, and Monaco never sees it", async () => {
    const view = render(
      <TabGroupPanel
        groupId="group-b"
        worktreeId="wt-b"
        isVisible
        isFocused={false}
        hasSplitGroups
        touchesLeftEdge={false}
        touchesRightEdge={false}
        reserveClosedExplorerToggleSpace={false}
        reserveCollapsedSidebarHeaderSpace={false}
      />
    )
    const input = await view.findByTestId('monaco-input')
    drag(input, 'dragover')
    const drop = drag(input, 'drop')

    expect(drop.defaultPrevented).toBe(true)
    expect(mocks.monacoSawDrop).not.toHaveBeenCalled()
    expect(mocks.capture).toHaveBeenCalledWith({ worktreeId: 'wt-b', groupId: 'group-b' })
    await waitFor(() => expect(mocks.deliver).toHaveBeenCalledWith(['/Users/me/dropped.md']))
  })
})
