// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { createTabsSliceMockApi } from '@/store/slices/tabs-slice-test-harness'
import { WorkspacePaneActions } from './cross-project-panes/WorkspacePaneActions'
import { TooltipProvider } from './ui/tooltip'
import { installIpcPtyWindow } from './terminal-pane/pty-transport-test-harness'
import { createIpcPtyTransport } from './terminal-pane/pty-transport'
import {
  registerWorkspaceViewControl,
  receiveWorkspaceViewControllers
} from './cross-project-panes/workspace-view-control-state'
import { captureWorkspaceViews } from './cross-project-panes/workspace-view-packet'
import { canControlWorkspaceBrowserPage } from './cross-project-panes/workspace-browser-control'

const initial = useAppStore.getState()
const domWindow = window
beforeEach(() => {
  const api = createTabsSliceMockApi()
  globalThis.window = domWindow
  Object.assign(window, { api })
  useAppStore.setState(initial, true)
})
afterEach(() => {
  globalThis.window = domWindow
  cleanup()
})

describe('workspace view continuity', () => {
  it('revokes browser guest and chrome input synchronously before handoff acknowledges', () => {
    useAppStore.setState({ activeWorktreeId: 'project' })
    const state = useAppStore.getState()
    state.createUnifiedTab('project', 'browser', { executionHostId: 'local', entityId: 'browser' })
    state.initializeWindowPanes()
    useAppStore.setState({ browserPagesByWorkspace: { browser: [{ id: 'page' } as never] } })
    const entries = registerWorkspaceViewControl(
      1,
      captureWorkspaceViews(
        useAppStore.getState(),
        Object.keys(useAppStore.getState().windowPaneLayout!.views),
        { local: 'host' }
      )
    )
    const { container } = render(
      <div data-browser-overlay-tab-id="browser">
        <div data-browser-page-viewport-id="page" />
      </div>
    )
    receiveWorkspaceViewControllers({ [entries[0].key]: { windowId: 2, viewId: 'other' } })
    expect(canControlWorkspaceBrowserPage('page')).toBe(false)
    expect((container.firstElementChild as HTMLElement).inert).toBe(true)
    expect((container.querySelector('[data-browser-page-viewport-id]') as HTMLElement).inert).toBe(
      true
    )
  })
  it('gates primary input, paste, query replies and viewport changes while another window controls', async () => {
    const domWindow = window
    installIpcPtyWindow(domWindow, {})
    useAppStore.setState({ activeWorktreeId: 'project' })
    const state = useAppStore.getState()
    state.createUnifiedTab('project', 'terminal', { executionHostId: 'local', entityId: 'shell' })
    useAppStore.setState({
      tabsByWorktree: {
        project: [
          {
            id: 'shell',
            worktreeId: 'project',
            ptyId: 'pty-1',
            title: 'Shell',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      }
    })
    state.initializeWindowPanes()
    const layout = useAppStore.getState().windowPaneLayout!
    const entries = registerWorkspaceViewControl(
      1,
      captureWorkspaceViews(useAppStore.getState(), Object.keys(layout.views), { local: 'host' })
    )
    const transport = createIpcPtyTransport()
    await transport.connect({ url: '', callbacks: {} })
    receiveWorkspaceViewControllers({ [entries[0].key]: { windowId: 2, viewId: 'other' } })
    expect(transport.sendInput('key')).toBe(false)
    expect(await transport.sendInputAccepted?.('paste')).toBe(false)
    expect(transport.sendInputImmediate('query reply')).toBe(false)
    expect(transport.resize(120, 40)).toBe(false)
    expect(transport.claimViewport?.(120, 40)).toBe(false)
    expect(window.api.pty.write).not.toHaveBeenCalled()
    receiveWorkspaceViewControllers({
      [entries[0].key]: { windowId: 1, viewId: entries[0].viewId }
    })
    expect(transport.sendInput('key')).toBe(true)
    transport.detach?.()
    expect(window.api.pty.kill).not.toHaveBeenCalled()
  })
  it('does not offer a duplicate view action for an already placed session', () => {
    const state = useAppStore.getState()
    useAppStore.setState({ activeWorktreeId: 'project' })
    state.createUnifiedTab('project', 'terminal', {
      executionHostId: 'local',
      entityId: 'existing-shell'
    })
    state.initializeWindowPanes()
    const layout = useAppStore.getState().windowPaneLayout!
    const original = layout.views[layout.panes[layout.activePaneId].selectedViewId!]
    render(
      <TooltipProvider>
        <WorkspacePaneActions paneId={layout.activePaneId} expanded={false} split={false} />
      </TooltipProvider>
    )
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Window actions' }), { button: 0 })
    expect(screen.queryByRole('menuitem', { name: 'Open Another View' })).toBeNull()
    act(() => state.openAnotherWorkspaceView(layout.activePaneId))
    const next = useAppStore.getState().windowPaneLayout!
    expect(Object.keys(next.panes)).toHaveLength(1)
    expect(Object.values(next.views)).toHaveLength(1)
    expect(next.views[original.id].id).toBe(original.id)
    expect(useAppStore.getState().getTab(original.tabId)).toBeTruthy()
    expect(window.api.pty.spawn).not.toHaveBeenCalled()
    expect(window.api.pty.kill).not.toHaveBeenCalled()
  })
})
