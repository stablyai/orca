// @vitest-environment happy-dom

import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'

const h: { keydown?: (event: KeyboardEvent) => void } = vi.hoisted(() => ({}))

vi.mock('@/store/index', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      rightSidebarOpen: true,
      rightSidebarTab: 'explorer',
      rightSidebarExplorerView: 'files',
      keybindings: undefined
    })
}))
vi.mock('@/lib/app-keyboard-router', () => ({
  addAppKeyListener: (_type: string, listener: (event: KeyboardEvent) => void) => {
    h.keydown = listener
  },
  removeAppKeyListener: () => {}
}))

import { useFileExplorerKeys } from './useFileExplorerKeys'

const selectedFile = { name: 'notes.txt', path: '/repo/notes.txt', relativePath: 'notes.txt' }

function Explorer({
  hostOverlay,
  requestDeleteAll
}: {
  hostOverlay: boolean
  requestDeleteAll: (nodes: unknown[]) => void
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  useFileExplorerKeys({
    containerRef,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the Delete path reads only these projection lookups.
    rowProjection: { getRowAtIndex: () => null, getRowsByPaths: () => [] } as never,
    expandedPaths: new Set(),
    canToggleDirectories: true,
    inlineInput: null,
    selectedPaths: new Set(),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the Delete path reads only path and outsideProject.
    selectedNode: selectedFile as never,
    activateNode: vi.fn(),
    moveSelection: vi.fn(),
    toggleDir: vi.fn(),
    startRename: vi.fn(),
    requestDelete: vi.fn(),
    requestDeleteAll,
    scrollToIndex: vi.fn(),
    activeWorktreeId: 'wt-1',
    pathOwner: 'unresolved'
  })
  return (
    <div ref={containerRef} data-orca-explorer-shell="">
      <button type="button">Toolbar</button>
      {hostOverlay ? <div data-file-explorer-host-overlay="" /> : null}
    </div>
  )
}

// Why: Host mode can leave focus on the shared toolbar, so Delete must not reach the hidden tree.
it.each([
  ['trashes the selection without the Host overlay', false, [[[selectedFile]]]],
  ['leaves the hidden tree alone under the Host overlay', true, []]
])('Delete with focus on the toolbar %s', (_label, hostOverlay, expected) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const requestDeleteAll = vi.fn()
  act(() => root.render(<Explorer hostOverlay={hostOverlay} requestDeleteAll={requestDeleteAll} />))
  container.querySelector('button')?.focus()

  h.keydown?.(new KeyboardEvent('keydown', { key: 'Delete' }))

  expect(requestDeleteAll.mock.calls).toEqual(expected)
  act(() => root.unmount())
  container.remove()
})
