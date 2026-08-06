// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useRef } from 'react'
import { useFileExplorerKeys } from './useFileExplorerKeys'
import { createFileExplorerRowProjection } from './file-explorer-row-projection'
import type { TreeNode } from './file-explorer-types'

const mocks = vi.hoisted(() => ({
  openFilePath: vi.fn(),
  writeClipboardText: vi.fn(),
  state: {
    rightSidebarOpen: true,
    rightSidebarTab: 'explorer',
    rightSidebarExplorerView: 'files',
    keybindings: {} as Record<string, string[]>,
    settings: { activeRuntimeEnvironmentId: null as string | null },
    repos: [{ id: 'repo-1', connectionId: null as string | null }],
    worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] },
    activeWorktreeId: 'wt-1' as string | null
  }
}))

vi.mock('@/store', () => {
  const useAppStore = (selector: (state: typeof mocks.state) => unknown): unknown =>
    selector(mocks.state)
  useAppStore.getState = (): typeof mocks.state => mocks.state
  return { useAppStore }
})

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const fileNode: TreeNode = {
  name: 'index.ts',
  path: '/repo/src/index.ts',
  relativePath: 'src/index.ts',
  isDirectory: false,
  depth: 1
}

function ShortcutHarness(): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)

  useFileExplorerKeys({
    containerRef,
    rowProjection: createFileExplorerRowProjection([fileNode]),
    expandedPaths: new Set(),
    canToggleDirectories: true,
    inlineInput: null,
    selectedPaths: new Set([fileNode.path]),
    selectedNode: fileNode,
    activateNode: vi.fn(),
    moveSelection: vi.fn(),
    toggleDir: vi.fn(),
    startRename: vi.fn(),
    requestDelete: vi.fn(),
    requestDeleteAll: vi.fn(),
    scrollToIndex: vi.fn(),
    activeWorktreeId: 'wt-1'
  })

  return (
    <div ref={containerRef} data-orca-explorer-shell>
      <div data-index="0">
        <button type="button">index.ts</button>
      </div>
    </div>
  )
}

function pressInExplorer(init: KeyboardEventInit): void {
  const { getByRole } = render(<ShortcutHarness />)
  getByRole('button').focus()
  fireEvent.keyDown(window, { bubbles: true, ...init })
}

beforeEach(() => {
  mocks.openFilePath.mockReset().mockResolvedValue(true)
  mocks.writeClipboardText.mockReset()
  mocks.state.keybindings = {}
  mocks.state.settings = { activeRuntimeEnvironmentId: null }
  ;(
    globalThis as unknown as {
      window: {
        api: {
          shell: { openFilePath: typeof mocks.openFilePath }
          ui: { writeClipboardText: typeof mocks.writeClipboardText }
        }
      }
    }
  ).window.api = {
    shell: { openFilePath: mocks.openFilePath },
    ui: { writeClipboardText: mocks.writeClipboardText }
  }
})

afterEach(cleanup)

describe('open-with-default-app explorer shortcut', () => {
  it('opens the focused row with the OS default app on Mod+O', () => {
    pressInExplorer({ key: 'o', code: 'KeyO', ctrlKey: true })

    expect(mocks.openFilePath).toHaveBeenCalledWith('/repo/src/index.ts')
  })

  it('ignores the chord without the Mod modifier', () => {
    pressInExplorer({ key: 'o', code: 'KeyO' })

    expect(mocks.openFilePath).not.toHaveBeenCalled()
  })

  it('honors a user rebind from Settings', () => {
    mocks.state.keybindings = { 'fileExplorer.openWithSystemDefault': ['Ctrl+Alt+K'] }
    pressInExplorer({ key: 'o', code: 'KeyO', ctrlKey: true })
    expect(mocks.openFilePath).not.toHaveBeenCalled()

    cleanup()
    pressInExplorer({ key: 'k', code: 'KeyK', ctrlKey: true, altKey: true })
    expect(mocks.openFilePath).toHaveBeenCalledWith('/repo/src/index.ts')
  })

  it('stays inert while focus is outside the explorer', () => {
    render(<ShortcutHarness />)
    fireEvent.keyDown(window, { key: 'o', code: 'KeyO', ctrlKey: true, bubbles: true })

    expect(mocks.openFilePath).not.toHaveBeenCalled()
  })
})
