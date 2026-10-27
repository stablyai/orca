// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { store } = vi.hoisted(() => ({
  store: {
    state: {
      sidebarOpen: true,
      rightSidebarOpen: true,
      folderWorkspaces: [],
      repos: [{ id: 'repo', displayName: 'orca' }],
      getKnownWorktreeById: () => ({ repoId: 'repo', displayName: 'feature', branch: '', path: '' })
    }
  }
}))
vi.mock('../../store', () => ({
  useAppStore: (selector: (state: typeof store.state) => unknown) => selector(store.state)
}))
vi.mock('@/lib/workspace-grid-view-actions', () => ({
  focusWorkspaceGridViewMember: vi.fn(),
  removeWorkspaceFromGridViewKeepingFocus: vi.fn()
}))
vi.mock('../ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => values?.[name] ?? '')
}))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

import { WorkspaceGridViewCellHeader } from './WorkspaceGridViewCellHeader'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  root = createRoot(container)
  store.state.sidebarOpen = true
  store.state.rightSidebarOpen = true
})
afterEach(() => {
  act(() => root.unmount())
})

function renderHeader(windowCorners: { topLeft: boolean; topRight: boolean }): HTMLElement[] {
  act(() => {
    root.render(
      <WorkspaceGridViewCellHeader
        workspaceId="repo::/feature"
        workspacePath="/feature"
        isFocused
        windowCorners={windowCorners}
      />
    )
  })
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-workspace-grid-view-cell-header] > div')
  )
}

describe('WorkspaceGridViewCellHeader window-corner clearance', () => {
  it('reserves room for the explorer toggle when the right sidebar is closed', () => {
    store.state.rightSidebarOpen = false
    const spacers = renderHeader({ topLeft: false, topRight: true })
    expect(spacers.map((spacer) => spacer.style.width)).toEqual([
      'calc(40px + var(--window-controls-width, 0px))'
    ])
  })

  it('reserves room for the collapsed sidebar toggle in the top-left cell', () => {
    store.state.sidebarOpen = false
    const spacers = renderHeader({ topLeft: true, topRight: false })
    expect(spacers.map((spacer) => spacer.style.width)).toEqual([
      'var(--collapsed-sidebar-header-width)'
    ])
  })

  it('reserves nothing while both sidebars are open or the cell is not at a corner', () => {
    expect(renderHeader({ topLeft: true, topRight: true })).toHaveLength(0)
    store.state.sidebarOpen = false
    store.state.rightSidebarOpen = false
    expect(renderHeader({ topLeft: false, topRight: false })).toHaveLength(0)
  })

  it('shows the workspace and project names', () => {
    renderHeader({ topLeft: false, topRight: false })
    expect(container.textContent).toContain('feature')
    expect(container.textContent).toContain('orca')
  })

  it('names the workspace and its project in the remove button', () => {
    renderHeader({ topLeft: false, topRight: false })
    // Why: every cell has a remove button, so a screen reader must hear which one this is.
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Remove from Grid View: feature (orca)'
    )
  })

  it('names only the workspace when its project is unknown', () => {
    const repos = store.state.repos
    store.state.repos = []
    try {
      renderHeader({ topLeft: false, topRight: false })
      expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(
        'Remove from Grid View: feature'
      )
    } finally {
      store.state.repos = repos
    }
  })
})
