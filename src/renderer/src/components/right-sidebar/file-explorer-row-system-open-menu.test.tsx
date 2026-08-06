// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FileExplorerRow } from './FileExplorerRow'
import type { TreeNode } from './file-explorer-types'

const mocks = vi.hoisted(() => ({
  openFilePath: vi.fn(),
  openPath: vi.fn(),
  state: {
    settings: { activeRuntimeEnvironmentId: null as string | null },
    repos: [{ id: 'repo-1', connectionId: null as string | null }],
    worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] },
    activeWorktreeId: 'wt-1' as string | null,
    keybindings: {},
    openMarkdownPreview: vi.fn()
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

function renderRow(node: TreeNode = fileNode): void {
  render(
    <FileExplorerRow
      node={node}
      isExpanded={false}
      isLoading={false}
      isSelected={false}
      isFlashing={false}
      selectedPaths={new Set()}
      nodeStatus={null}
      statusColor={null}
      isIgnored={false}
      deleteShortcutLabel="Del"
      canCollapseFolderSubtree={false}
      targetDir="/repo/src"
      targetDepth={1}
      selectionSize={1}
      onClick={vi.fn()}
      onDoubleClick={vi.fn()}
      onViewFile={vi.fn()}
      onContextMenuSelect={vi.fn()}
      onCopyPaths={vi.fn()}
      onStartNew={vi.fn()}
      onStartRename={vi.fn()}
      onDuplicate={vi.fn()}
      onAddFolderAsProject={vi.fn()}
      canAddAsProject={false}
      onOpenInTerminal={vi.fn()}
      onRequestDelete={vi.fn()}
      onCollapseFolderSubtree={vi.fn()}
      onFindInFolder={vi.fn()}
      onMoveDrop={vi.fn()}
      onDragTargetChange={vi.fn()}
      onDragSourceChange={vi.fn()}
      onDragExpandDir={vi.fn()}
      onNativeDragTargetChange={vi.fn()}
      onNativeDragExpandDir={vi.fn()}
    />
  )
  fireEvent.contextMenu(screen.getByRole('button'))
}

beforeEach(() => {
  mocks.openFilePath.mockReset().mockResolvedValue(true)
  mocks.openPath.mockReset().mockResolvedValue(undefined)
  mocks.state.settings = { activeRuntimeEnvironmentId: null }
  mocks.state.repos = [{ id: 'repo-1', connectionId: null }]
  ;(
    globalThis as unknown as {
      window: {
        api: { shell: { openFilePath: typeof mocks.openFilePath; openPath: typeof mocks.openPath } }
      }
    }
  ).window.api = { shell: { openFilePath: mocks.openFilePath, openPath: mocks.openPath } }
})

afterEach(cleanup)

describe('file explorer open-with-default-app menu item', () => {
  it('launches the OS file association and leaves reveal untouched', async () => {
    renderRow()

    fireEvent.click(await screen.findByText('Open with Default App'))

    expect(mocks.openFilePath).toHaveBeenCalledWith('/repo/src/index.ts')
    expect(mocks.openPath).not.toHaveBeenCalled()
  })

  it('keeps reveal on the file-manager API', async () => {
    renderRow()

    fireEvent.click(await screen.findByText(/Reveal in|Open Containing Folder/))

    expect(mocks.openPath).toHaveBeenCalledWith('/repo/src/index.ts')
    expect(mocks.openFilePath).not.toHaveBeenCalled()
  })

  it('labels directories as folders', async () => {
    renderRow({
      name: 'src',
      path: '/repo/src',
      relativePath: 'src',
      isDirectory: true,
      depth: 0
    })

    expect(await screen.findByText('Open Folder with Default App')).toBeTruthy()
  })

  it('never sends a remote-runtime path to the local OS', async () => {
    mocks.state.settings = { activeRuntimeEnvironmentId: 'runtime-1' }
    renderRow()

    fireEvent.click(await screen.findByText('Open with Default App'))

    expect(mocks.openFilePath).not.toHaveBeenCalled()
  })
})
