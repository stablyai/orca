// @vitest-environment happy-dom

import React, { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SheetDescription, SheetTitle } from '@/components/ui/sheet'
import WorkspaceKanbanSearchField from './WorkspaceKanbanSearchField'
import WorkspaceKanbanSheet from './WorkspaceKanbanSheet'
import { useWorkspaceKanbanDrawerLingering } from './use-workspace-kanban-drawer-lingering'
import {
  TOGGLE_WORKSPACE_BOARD_EVENT,
  useWorkspaceBoardPanel,
  type WorkspaceBoardPanelState
} from './useWorkspaceBoardPanel'

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ recordFeatureInteraction: vi.fn() }) }
}))

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })

let root: Root
let panel: WorkspaceBoardPanelState

function Board(): React.JSX.Element {
  panel = useWorkspaceBoardPanel()
  const boardRef = useRef<HTMLDivElement>(null)
  const lingering = useWorkspaceKanbanDrawerLingering(panel.workspaceBoardRenderedOpen)
  const [query, setQuery] = useState('')
  return (
    <>
      <input aria-label="Terminal" />
      <button type="button">Other pane</button>
      {panel.workspaceBoardRenderedOpen || lingering ? (
        <WorkspaceKanbanSheet
          boardRef={boardRef}
          open={panel.workspaceBoardRenderedOpen}
          dragPreview={panel.workspaceBoardDragPreviewOpen}
          preserveOpenForMenu={false}
          onOpenChange={panel.handleWorkspaceBoardOpenChange}
          sidebarOpen={true}
          sidebarWidth={280}
          statusBarVisible={true}
        >
          <SheetTitle>Workspace board</SheetTitle>
          <SheetDescription>Organize workspaces</SheetDescription>
          <WorkspaceKanbanSearchField
            searchInputRef={panel.workspaceBoardSearchRef}
            query={query}
            isFiltering={query !== ''}
            isTooLarge={false}
            matchCount={0}
            totalCount={0}
            onQueryChange={setQuery}
            onClear={() => setQuery('')}
            onClose={panel.closeWorkspaceBoard}
          />
        </WorkspaceKanbanSheet>
      ) : null}
    </>
  )
}

function field(label: string): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  if (!input) {
    throw new Error(`Missing input: ${label}`)
  }
  return input
}

async function toggle(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new CustomEvent(TOGGLE_WORKSPACE_BOARD_EVENT))
  })
}

async function escape(): Promise<void> {
  await act(async () => {
    field('Search workspaces').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    )
  })
}

beforeEach(async () => {
  vi.useFakeTimers()
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<Board />))
  field('Terminal').focus()
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
    await vi.runAllTimersAsync()
  })
  document.body.replaceChildren()
  vi.useRealTimers()
})

describe('Workspace Board search focus', () => {
  it('focuses search on a toggle open and restores the opener on a toggle close', async () => {
    const terminal = field('Terminal')
    await toggle()
    expect(document.activeElement).toBe(field('Search workspaces'))
    await toggle()
    expect(document.activeElement).toBe(terminal)
  })

  it('restores focus after Escape closes an empty search', async () => {
    const terminal = field('Terminal')
    await toggle()
    await escape()
    expect(panel.workspaceBoardOpen).toBe(false)
    expect(document.activeElement).toBe(terminal)
  })

  it('clears search on the first Escape and restores focus on the second', async () => {
    await toggle()
    await act(async () => {
      const input = field('Search workspaces')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'orca')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await escape()
    expect(panel.workspaceBoardOpen).toBe(true)
    expect(field('Search workspaces').value).toBe('')
    expect(document.activeElement).toBe(field('Search workspaces'))
    await escape()
    expect(panel.workspaceBoardOpen).toBe(false)
    expect(document.activeElement).toBe(field('Terminal'))
  })

  it('does not take focus for drag previews or drag solidification', async () => {
    const terminal = field('Terminal')
    await act(async () => panel.previewWorkspaceBoardFromDrag())
    expect(document.activeElement).toBe(terminal)
    await act(async () => panel.solidifyWorkspaceBoardFromDrag())
    expect(document.activeElement).toBe(terminal)
    await act(async () => panel.closeWorkspaceBoard())
    await act(async () => vi.runAllTimersAsync())
    expect(document.activeElement).toBe(terminal)
  })

  it('focuses the already-mounted search when the toggle commits a drag preview', async () => {
    const terminal = field('Terminal')
    await act(async () => panel.previewWorkspaceBoardFromDrag())
    const search = field('Search workspaces')
    await toggle()
    expect(panel.workspaceBoardDragPreviewOpen).toBe(false)
    expect(document.activeElement).toBe(search)
    await toggle()
    expect(document.activeElement).toBe(terminal)
  })

  it('refocuses on a quick reopen and remembers the new opener', async () => {
    await toggle()
    await toggle()
    const other = document.querySelector('button')
    if (!other) {
      throw new Error('Missing other pane')
    }
    other.focus()
    await toggle()
    expect(document.activeElement).toBe(field('Search workspaces'))
    await toggle()
    await act(async () => vi.runAllTimersAsync())
    expect(document.activeElement).toBe(other)
  })

  it('leaves focus in another pane through close and delayed Sheet unmount', async () => {
    await toggle()
    const other = document.querySelector('button')
    if (!other) {
      throw new Error('Missing other pane')
    }
    other.focus()
    await toggle()
    await act(async () => vi.runAllTimersAsync())
    expect(document.activeElement).toBe(other)
  })

  it('does not restore a disconnected opener', async () => {
    const terminal = document.createElement('input')
    document.body.appendChild(terminal)
    terminal.focus()
    await toggle()
    terminal.remove()
    await toggle()
    expect(document.activeElement).not.toBe(terminal)
  })
})
