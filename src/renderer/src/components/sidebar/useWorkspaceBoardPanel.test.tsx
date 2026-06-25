// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OPEN_WORKSPACE_BOARD_EVENT,
  useWorkspaceBoardPanel,
  type WorkspaceBoardPanelState
} from './useWorkspaceBoardPanel'

const mocks = vi.hoisted(() => ({
  recordFeatureInteraction: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      recordFeatureInteraction: mocks.recordFeatureInteraction
    })
  }
}))

let latestState: WorkspaceBoardPanelState | null = null
const roots: Root[] = []

function HookProbe(): null {
  latestState = useWorkspaceBoardPanel()
  return null
}

async function renderHookProbe(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(<HookProbe />)
  })
}

function panelState(): WorkspaceBoardPanelState {
  if (!latestState) {
    throw new Error('Hook state has not been rendered')
  }
  return latestState
}

async function updatePanel(update: (state: WorkspaceBoardPanelState) => void): Promise<void> {
  await act(async () => {
    update(panelState())
  })
}

async function pressEscape(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

describe('useWorkspaceBoardPanel', () => {
  beforeEach(() => {
    latestState = null
    mocks.recordFeatureInteraction.mockReset()
  })

  afterEach(() => {
    roots.splice(0).forEach((root) => {
      act(() => root.unmount())
    })
    document.body.replaceChildren()
  })

  it('toggles the board and records the feature interaction when opened', async () => {
    await renderHookProbe()

    await updatePanel((state) => state.toggleWorkspaceBoard())

    expect(panelState().workspaceBoardOpen).toBe(true)
    expect(panelState().workspaceBoardRenderedOpen).toBe(true)
    expect(panelState().workspaceBoardDragPreviewOpen).toBe(false)
    expect(mocks.recordFeatureInteraction).toHaveBeenCalledExactlyOnceWith('workspace-board')

    await updatePanel((state) => state.toggleWorkspaceBoard())

    expect(panelState().workspaceBoardOpen).toBe(false)
    expect(panelState().workspaceBoardRenderedOpen).toBe(false)
    expect(mocks.recordFeatureInteraction).toHaveBeenCalledOnce()
  })

  it('opens the board from the shortcut bridge event', async () => {
    await renderHookProbe()

    await act(async () => {
      window.dispatchEvent(new CustomEvent(OPEN_WORKSPACE_BOARD_EVENT))
    })

    expect(panelState().workspaceBoardOpen).toBe(true)
    expect(panelState().workspaceBoardRenderedOpen).toBe(true)
    expect(mocks.recordFeatureInteraction).toHaveBeenCalledExactlyOnceWith('workspace-board')
  })

  it('renders a drag preview without recording an open interaction', async () => {
    await renderHookProbe()

    await updatePanel((state) => state.previewWorkspaceBoardFromDrag())

    expect(panelState().workspaceBoardOpen).toBe(false)
    expect(panelState().workspaceBoardRenderedOpen).toBe(true)
    expect(panelState().workspaceBoardDragPreviewOpen).toBe(true)
    expect(mocks.recordFeatureInteraction).not.toHaveBeenCalled()
  })

  it('cancels an uncommitted drag preview', async () => {
    await renderHookProbe()

    await updatePanel((state) => state.previewWorkspaceBoardFromDrag())
    await updatePanel((state) => state.cancelWorkspaceBoardDragPreview())

    expect(panelState().workspaceBoardOpen).toBe(false)
    expect(panelState().workspaceBoardRenderedOpen).toBe(false)
    expect(panelState().workspaceBoardDragPreviewOpen).toBe(false)
  })

  it('solidifies a drag preview and keeps the board open after drag cleanup', async () => {
    await renderHookProbe()

    await updatePanel((state) => state.previewWorkspaceBoardFromDrag())
    await updatePanel((state) => state.solidifyWorkspaceBoardFromDrag())
    await updatePanel((state) => state.cancelWorkspaceBoardDragPreview())

    expect(panelState().workspaceBoardOpen).toBe(true)
    expect(panelState().workspaceBoardRenderedOpen).toBe(true)
    expect(panelState().workspaceBoardDragPreviewOpen).toBe(false)
    expect(mocks.recordFeatureInteraction).toHaveBeenCalledExactlyOnceWith('workspace-board')
  })

  it('keeps the board open on Escape while a nested board menu is open', async () => {
    await renderHookProbe()

    await updatePanel((state) => state.openWorkspaceBoard())
    await updatePanel((state) => state.setWorkspaceBoardMenuOpen(true))
    await pressEscape()

    expect(panelState().workspaceBoardOpen).toBe(true)

    await updatePanel((state) => state.setWorkspaceBoardMenuOpen(false))
    await pressEscape()

    expect(panelState().workspaceBoardOpen).toBe(false)
  })

  it('lets Escape close the board while non-interactive tooltip content is open', async () => {
    await renderHookProbe()
    const tooltip = document.createElement('div')
    tooltip.setAttribute('data-slot', 'tooltip-content')
    tooltip.setAttribute('data-state', 'open')
    document.body.appendChild(tooltip)

    await updatePanel((state) => state.openWorkspaceBoard())
    await pressEscape()

    expect(panelState().workspaceBoardOpen).toBe(false)
  })

  it('lets Escape close the board when the board sheet itself is the open dialog', async () => {
    await renderHookProbe()
    const boardSheet = document.createElement('div')
    boardSheet.setAttribute('role', 'dialog')
    boardSheet.setAttribute('data-state', 'open')
    boardSheet.setAttribute('data-workspace-board-sheet', '')
    document.body.appendChild(boardSheet)

    await updatePanel((state) => state.openWorkspaceBoard())
    await pressEscape()

    expect(panelState().workspaceBoardOpen).toBe(false)
  })

  it('keeps the board open on Escape while an interactive popover is open', async () => {
    await renderHookProbe()
    const popover = document.createElement('div')
    popover.setAttribute('data-slot', 'popover-content')
    popover.setAttribute('data-state', 'open')
    document.body.appendChild(popover)

    await updatePanel((state) => state.openWorkspaceBoard())
    await pressEscape()

    expect(panelState().workspaceBoardOpen).toBe(true)
  })

  it('keeps the board open on Escape while a nested dialog is open', async () => {
    await renderHookProbe()
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('data-state', 'open')
    document.body.appendChild(dialog)

    await updatePanel((state) => state.openWorkspaceBoard())
    await pressEscape()

    expect(panelState().workspaceBoardOpen).toBe(true)
  })
})
