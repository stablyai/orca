// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceWindowMenu } from './WorkspaceWindowMenu'
import { useAppStore } from '@/store'
import { TooltipProvider } from '../ui/tooltip'

afterEach(cleanup)
it.each(['Move to Window', 'Combine Windows as Tabs', 'Combine Windows as Panes'])(
  'routes %s through the native transaction',
  async (label) => {
    const transfer = vi.fn(async () => true)
    Object.assign(window, {
      orcaWorkspaceViews: {
        ready: async () => 1,
        list: async () => [
          { id: 1, title: 'Here' },
          { id: 2, title: 'Other' }
        ],
        transfer
      }
    })
    useAppStore.setState({
      windowPaneLayout: {
        version: 1,
        root: { type: 'leaf', groupId: 'pane' },
        activePaneId: 'pane',
        expandedPaneId: null,
        views: {},
        panes: { pane: { id: 'pane', viewIds: ['view'], selectedViewId: 'view' } }
      }
    })
    render(
      <TooltipProvider>
        <WorkspaceWindowMenu paneId="pane" />
      </TooltipProvider>
    )
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Window actions' }), {
      button: 0,
      ctrlKey: false
    })
    fireEvent.pointerMove(await screen.findByRole('menuitem', { name: label }))
    fireEvent.keyDown(screen.getByRole('menuitem', { name: label }), { key: 'ArrowRight' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Other (2)' }))
    expect(transfer).toHaveBeenCalledWith({
      destinationId: 2,
      mode: label.endsWith('Panes') ? 'panes' : 'tabs',
      ...(label === 'Move to Window' ? { viewIds: ['view'] } : {})
    })
  }
)
