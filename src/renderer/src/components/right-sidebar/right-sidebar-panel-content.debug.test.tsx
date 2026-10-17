// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RightSidebarPanelContent } from './right-sidebar-panel-content'

const state = {
  activeWorktreeId: 'repo-1::/repo/main',
  worktreesByRepo: {
    'repo-1': [{ id: 'repo-1::/repo/main', repoId: 'repo-1', path: '/repo/main' }]
  }
}

vi.mock('@/store', () => ({
  useAppStore: (select: (s: unknown) => unknown) => select(state)
}))

// Core reports a realpath that differs from the renderer's path when the root is under a symlink.
vi.mock('../debug/DebugPanel', () => ({
  DebugPanel: ({
    children
  }: {
    children?: React.ReactNode | ((corePath: string) => React.ReactNode)
  }) => (
    <div data-testid="debug-panel">
      {typeof children === 'function' ? children('/real/main') : children}
    </div>
  )
}))

vi.mock('../debug/DebugPanelSections', () => ({
  default: ({
    worktreePath,
    rendererPath,
    repoId
  }: {
    worktreePath: string
    rendererPath?: string
    repoId?: string
  }) => (
    <div
      data-testid="debug-sections"
      data-worktree-path={worktreePath}
      data-renderer-path={rendererPath}
      data-repo-id={repoId}
    />
  )
}))

vi.mock('./FileExplorer', () => ({
  default: () => <div data-testid="file-explorer" />
}))

const roots: ReturnType<typeof createRoot>[] = []

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) {
      root.unmount()
    }
  })
  document.body.innerHTML = ''
})

async function renderContent(effectiveTab: 'debug' | 'explorer'): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(<RightSidebarPanelContent effectiveTab={effectiveTab} rightSidebarOpen />)
  })
  // Why: the panels are lazy; let the dynamic import and Suspense settle.
  await act(async () => {
    await vi.dynamicImportSettled()
  })
  return container
}

describe('RightSidebarPanelContent debug tab', () => {
  it("renders the sections keyed by core's path, with the renderer path only for lookup", async () => {
    const container = await renderContent('debug')

    const panel = container.querySelector('[data-testid="debug-panel"]')
    expect(panel).not.toBeNull()
    const sections = panel?.querySelector('[data-testid="debug-sections"]')
    expect(sections?.getAttribute('data-worktree-path')).toBe('/real/main')
    expect(sections?.getAttribute('data-renderer-path')).toBe('/repo/main')
    expect(sections?.getAttribute('data-repo-id')).toBe('repo-1')
    expect(container.querySelector('[data-testid="file-explorer"]')).toBeNull()
  })

  it('does not render the debug panel for another tab', async () => {
    const container = await renderContent('explorer')

    expect(container.querySelector('[data-testid="debug-panel"]')).toBeNull()
    expect(container.querySelector('[data-testid="file-explorer"]')).not.toBeNull()
  })
})
