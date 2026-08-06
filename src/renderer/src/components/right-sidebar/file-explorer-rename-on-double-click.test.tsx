// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { FileExplorerRow } from './FileExplorerRow'
import { isRenameHotspotTarget, resolveDirToggleTiming } from './file-explorer-dir-toggle-timing'
import type { TreeNode } from './file-explorer-types'

const mocks = vi.hoisted(() => ({
  settings: { fileExplorerRenameOnDoubleClick: true } as Record<string, unknown>
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      activeWorktreeId: 'wt-1',
      keybindings: {},
      openMarkdownPreview: vi.fn(),
      settings: mocks.settings
    })
}))

const directoryNode: TreeNode = {
  name: 'components',
  path: '/repo/src/components',
  relativePath: 'src/components',
  isDirectory: true,
  depth: 1
}

function renderRow(renameOnDoubleClick: boolean | undefined): {
  name: HTMLElement
  onStartRename: ReturnType<typeof vi.fn>
} {
  mocks.settings = { fileExplorerRenameOnDoubleClick: renameOnDoubleClick }
  const onStartRename = vi.fn()
  const view = render(
    <FileExplorerRow
      node={directoryNode}
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
      targetDepth={0}
      selectionSize={0}
      onClick={vi.fn()}
      onDoubleClick={vi.fn()}
      onViewFile={vi.fn()}
      onContextMenuSelect={vi.fn()}
      onCopyPaths={vi.fn()}
      onStartNew={vi.fn()}
      onStartRename={onStartRename}
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
  return { name: view.getByText(directoryNode.name), onStartRename }
}

describe('file explorer rename-on-double-click setting', () => {
  afterEach(cleanup)

  it('renames on a filename double-click while the setting is on', () => {
    const { name, onStartRename } = renderRow(true)

    fireEvent.doubleClick(name)

    expect(onStartRename).toHaveBeenCalledWith(directoryNode)
  })

  it('defaults to on when the setting was never written', () => {
    const { name, onStartRename } = renderRow(undefined)

    fireEvent.doubleClick(name)

    expect(onStartRename).toHaveBeenCalledWith(directoryNode)
  })

  it('drops the rename gesture while the setting is off', () => {
    const { name, onStartRename } = renderRow(false)

    fireEvent.doubleClick(name)

    expect(onStartRename).not.toHaveBeenCalled()
  })

  // Why: the whole point of the setting — with the hotspot gone, a filename click
  // no longer waits out the double-click window before toggling the directory.
  it('makes a filename click toggle immediately while the setting is off', () => {
    const { name } = renderRow(false)

    expect(isRenameHotspotTarget(name)).toBe(false)
    expect(resolveDirToggleTiming({ fromRenameHotspot: false, clickCount: 1 })).toBe('immediate')
  })

  it('keeps deferring a filename click while the setting is on', () => {
    const { name } = renderRow(true)

    expect(isRenameHotspotTarget(name)).toBe(true)
    expect(resolveDirToggleTiming({ fromRenameHotspot: true, clickCount: 1 })).toBe('deferred')
  })
})
