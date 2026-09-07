// @vitest-environment happy-dom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { useWindowPaneNavigation } from './cross-project-panes/use-window-pane-navigation'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import { createTabsSliceMockApi } from '../store/slices/tabs-slice-test-harness'
import { TooltipProvider } from './ui/tooltip'
import { CrossProjectPaneLayout } from './cross-project-panes/CrossProjectPaneLayout'
import { WorktreeSplitSurface } from './TerminalWorktreeSplitSurface'

vi.mock('./terminal-pane/TerminalPane', () => ({
  default: function TestTerminal({ tabId, isVisible }: { tabId: string; isVisible: boolean }) {
    const [identity] = useState(() => crypto.randomUUID())
    return (
      <div data-testid={`terminal-${tabId}`} data-visible={isVisible} data-identity={identity} />
    )
  }
}))
vi.mock('./editor/EditorPanel', () => ({
  default: function TestEditor({
    activeFileId,
    isVisible
  }: {
    activeFileId: string
    isVisible: boolean
  }) {
    const [draft, setDraft] = useState('original')
    return (
      <textarea
        aria-label={`Editor ${activeFileId}`}
        data-visible={isVisible}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
    )
  }
}))
vi.mock('./browser-pane/assemble-chrome/BrowserPaneOverlayLayer', () => ({
  RetainedBrowserPaneOverlayLayer: () => null
}))
vi.mock('./emulator-pane/EmulatorPaneOverlayLayer', () => ({ default: () => null }))
vi.mock('./native-chat/StructuredAgentSessionPaneOverlayLayer', () => ({ default: () => null }))
vi.mock('./tab-group/AiVaultSessionDropLayer', () => ({ default: () => null }))

const initial = useAppStore.getState()
beforeEach(() => {
  const domWindow = window
  const api = createTabsSliceMockApi()
  globalThis.window = domWindow
  Object.assign(window, { api })
  useAppStore.setState(initial, true)
  useAppStore.setState({ persistedUIReady: true, hydrationSucceeded: true, activeView: 'terminal' })
})
afterEach(cleanup)

function Surface({ worktreeId }: { worktreeId: string }) {
  const layout = useAppStore((s) => s.layoutByWorktree[worktreeId])
  return (
    <WorktreeSplitSurface
      worktreeId={worktreeId}
      worktreePath={`/${worktreeId}`}
      layout={layout}
      isVisible
      shouldMeasureHiddenWorktree={false}
      shouldColdParkTerminalPanes={false}
      isForceParked={false}
      activityTerminalPortals={[]}
      backgroundMountTabIds={null}
      activationDeferredMountTabIds={null}
    />
  )
}

describe('cross-project pane tabs', () => {
  it('keeps one mixed strip per pane and retains live surfaces and unsaved buffers through split and expand', async () => {
    const state = useAppStore.getState()
    const terminal = state.createUnifiedTab('alpha', 'terminal', {
      label: 'Shell',
      executionHostId: 'local'
    })
    const editor = state.createUnifiedTab('beta', 'editor', {
      entityId: 'draft',
      label: 'draft.txt',
      executionHostId: 'local'
    })
    useAppStore.setState({
      tabsByWorktree: {
        alpha: [
          {
            id: terminal.entityId,
            worktreeId: 'alpha',
            ptyId: 'live-pty',
            title: 'Shell',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      },
      openFiles: [
        {
          id: 'draft',
          worktreeId: 'beta',
          filePath: '/beta/draft.txt',
          relativePath: 'draft.txt',
          language: 'plaintext',
          mode: 'edit',
          isPreview: false,
          isDirty: false
        }
      ],
      activeWorktreeId: 'alpha',
      activeTabType: 'terminal',
      activeTabId: terminal.entityId
    })
    renderHook(useWindowPaneNavigation)
    render(
      <TooltipProvider>
        <div>
          <CrossProjectPaneLayout />
          <Surface worktreeId="alpha" />
          <Surface worktreeId="beta" />
        </div>
      </TooltipProvider>
    )
    expect(document.querySelectorAll('[data-tab-group-strip-id]')).toHaveLength(1)
    const terminalElement = screen.getByTestId(`terminal-${terminal.entityId}`)
    const identity = terminalElement.dataset.identity
    act(() => {
      useAppStore.setState({
        activeWorktreeId: 'beta',
        activeTabType: 'editor',
        activeFileId: 'draft'
      })
      state.activateTab(editor.id)
    })
    expect(screen.getByText('Shell')).toBeTruthy()
    expect(screen.getByText('draft.txt')).toBeTruthy()
    const input = await screen.findByRole('textbox', { name: 'Editor draft' })
    fireEvent.change(input, { target: { value: 'unsaved across split' } })
    fireEvent.click(screen.getByRole('button', { name: 'Split Right' }))
    expect(document.querySelectorAll('[data-tab-group-strip-id]')).toHaveLength(2)
    expect(terminalElement.dataset.visible).toBe('true')
    fireEvent.click(screen.getAllByRole('button', { name: 'Expand Pane' })[1])
    fireEvent.click(screen.getByRole('button', { name: 'Restore Layout' }))
    expect(screen.getByRole('textbox', { name: 'Editor draft' })).toBe(input)
    expect((input as HTMLTextAreaElement).value).toBe('unsaved across split')
    expect(screen.getByTestId(`terminal-${terminal.entityId}`).dataset.identity).toBe(identity)
    expect(state.getTab(terminal.id)?.entityId).toBe(terminal.entityId)
    expect(state.getTab(editor.id)?.worktreeId).toBe('beta')
    fireEvent.click(screen.getAllByRole('button', { name: 'Close Pane' })[1])
    expect(useAppStore.getState().tabsByWorktree.alpha[0].ptyId).toBe('live-pty')
    expect(useAppStore.getState().getTab(editor.id)).toBeTruthy()
    expect(window.api.pty.kill).not.toHaveBeenCalled()
  })
})
