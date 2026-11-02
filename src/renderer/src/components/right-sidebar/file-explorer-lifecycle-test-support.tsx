import { useCallback, useLayoutEffect, useMemo, type Dispatch, type SetStateAction } from 'react'
import { flushSync } from 'react-dom'
import { fireEvent, render } from '@testing-library/react'
import { Virtualizer } from '@tanstack/react-virtual'
import { vi } from 'vitest'
import { useFileExplorerTree } from './useFileExplorerTree'
import { useFileExplorerTreePaneState } from './use-file-explorer-tree-pane-state'
import { useFileExplorerSelection } from './useFileExplorerSelection'
import { useFileExplorerManualRefresh } from './useFileExplorerManualRefresh'
import { useAppStore } from '@/store'
import { getLocalPathOpenOwnerForRoute } from '@/lib/local-path-open-guard'
import { getVisibleFileExplorerWorktreePath } from './file-explorer-reset'
import { getExplorerDisplayRootPath } from './file-explorer-display-root'
import { createVisibleFileExplorerRowProjection } from './useFileExplorerVisibleRowProjection'
import { FileExplorerVirtualRows } from './FileExplorerVirtualRows'
import type { FileExplorerDirectoryListing } from './file-explorer-directory-listing'
import type { FileExplorerOperationOwner } from './file-explorer-types'

const emptyExpanded = new Set<string>()
export const visibleProps = { visible: true, id: 'wt', root: '/repo', scope: '/repo' }
export function useVisibleTree(
  { visible, id, root, scope }: typeof visibleProps,
  resetSelection: () => void,
  setNameFilterQuery: Dispatch<SetStateAction<string>>,
  owner: FileExplorerOperationOwner
) {
  const activeFileId = useAppStore((state) => state.activeFileId)
  const openFiles = useAppStore((state) => state.openFiles)
  const expanded = useAppStore((state) => state.expandedDirs[id]) ?? emptyExpanded
  const effectiveExpanded = useMemo(
    () => (scope === root ? expanded : new Set([...expanded, scope])),
    [expanded, scope, root]
  )
  const tree = useFileExplorerTree(root, effectiveExpanded, id, scope)
  const projection = createVisibleFileExplorerRowProjection(
    { dirCache: tree.dirCache, expanded, worktreePath: root, displayRootPath: scope },
    { showDotfiles: true, showGitIgnoredFiles: true, ignoredSet: new Set() }
  )
  const pathOwner = getLocalPathOpenOwnerForRoute({
    runtimeEnvironmentId: owner.kind === 'runtime' ? owner.environmentId : null,
    connectionId: owner.kind === 'ssh' ? owner.connectionId : null,
    ownerUnresolved: owner.kind === 'unresolved'
  })
  const selection = useFileExplorerSelection(projection, false, pathOwner)
  const { resetSelection: resetSelected } = selection
  const reset = useCallback(() => {
    resetSelected()
    resetSelection()
  }, [resetSelected, resetSelection])
  const pane = useFileExplorerTreePaneState({
    activeWorktreeId: id,
    activeRepo: null,
    worktreePath: root,
    visibleFilesWorktreePath: visible ? root : null,
    displayRootPath: scope,
    effectiveExpanded,
    expanded,
    activeFileId,
    openFiles,
    hasNameFilter: false,
    setNameFilterQuery,
    handleToggleNameFilterDir: vi.fn(),
    tree,
    selection: { ...selection, resetSelection: reset },
    selectedNode: selection.selectedPath ? projection.getRowByPath(selection.selectedPath) : null,
    rowProjection: projection,
    rowExpandedPaths: expanded,
    visibleRowCount: projection.getVisibleCount(),
    pathOwner
  })
  const manual = useFileExplorerManualRefresh(tree.refreshTree)
  return {
    ...tree,
    pane,
    manual,
    owner,
    input: pane.inlineInputState,
    hover: pane.dragDrop,
    handlers: pane.handlers,
    projection,
    selected: selection.selectedPath,
    setSelected: selection.setSingleSelectedPath,
    drag: pane.dragDrop.dragSourcePath,
    setDrag: pane.dragDrop.setDragSourcePath,
    native: pane.dragDrop.isNativeDragOver,
    setNative: (value: boolean) => {
      if (value) {
        const target = flushSync(() =>
          render(<div onDragEnter={pane.dragDrop.rootDragHandlers.onDragEnter} />)
        )
        try {
          const dataTransfer = new DataTransfer()
          dataTransfer.items.add(new File([], 'native-drag.txt'))
          // Happy DOM omits the browser Files marker for real file items.
          Object.defineProperty(dataTransfer, 'types', { value: ['Files'] })
          fireEvent.dragEnter(target.container.firstElementChild!, { dataTransfer })
        } finally {
          target.unmount()
        }
      } else {
        pane.dragDrop.clearNativeDragState()
      }
    },
    expanded,
    toggleDir: (_workspace: string, path: string) =>
      pane.handlers.handleClick(projection.getRowByPath(path)!),
    resetSelection,
    setNameFilterQuery
  }
}
export const listing = (...names: string[]): FileExplorerDirectoryListing => ({
  entries: names.map((name) => ({ name, isDirectory: false, isSymlink: false })),
  operationOwner: { kind: 'runtime', environmentId: 'host-a', executionHostId: 'runtime:host-a' }
})
export function gateRead() {
  let resolve!: (value: ReturnType<typeof listing>) => void
  let reject!: (error: Error) => void
  const promise = new Promise<ReturnType<typeof listing>>((finish, fail) => {
    resolve = finish
    reject = fail
  })
  return { promise, resolve, reject }
}

// Exercise the production projection/inline-row condition; row chrome is irrelevant to observation ownership.
export function renderInteractionTree(owner: FileExplorerOperationOwner, storeNavigation = false) {
  let current!: ReturnType<typeof useVisibleTree>
  const reset = vi.fn(),
    filter = vi.fn()
  function View() {
    const open = useAppStore((state) => state.rightSidebarOpen)
    const view = useAppStore((state) => state.rightSidebarExplorerView)
    const choice = useAppStore((state) => state.explorerDisplayRootByWorktree.wt)
    const rendered = useVisibleTree(
      storeNavigation
        ? {
            ...visibleProps,
            visible:
              getVisibleFileExplorerWorktreePath({
                rightSidebarOpen: open,
                explorerView: view,
                worktreePath: '/repo'
              }) !== null,
            scope: getExplorerDisplayRootPath('/repo', choice ?? '/')!
          }
        : visibleProps,
      reset,
      filter,
      owner
    )
    useLayoutEffect(() => {
      current = rendered
    })
    const { projection, input } = rendered
    const count = projection.getVisibleCount() + (input.inlineInputIndex >= 0 ? 1 : 0)
    const virtualizer = new Virtualizer<HTMLDivElement, Element>({
      count,
      getScrollElement: () => null,
      estimateSize: () => 26,
      scrollToFn: vi.fn(),
      observeElementRect: vi.fn(),
      observeElementOffset: vi.fn()
    })
    virtualizer.getTotalSize = () => count * 26
    virtualizer.getVirtualItems = Object.assign(
      () =>
        Array.from({ length: count }, (_, index) => {
          const inline = input.inlineInputIndex >= 0 && index === input.inlineInputIndex
          const rowIndex =
            input.inlineInputIndex >= 0 && index > input.inlineInputIndex ? index - 1 : index
          return {
            index,
            key: inline ? '__inline_input__' : projection.getRowAtIndex(rowIndex)!.path,
            start: index * 26,
            end: (index + 1) * 26,
            size: 26,
            lane: 0
          }
        }),
      { updateDeps: virtualizer.getVirtualItems.updateDeps }
    )
    virtualizer.measureElement = () => {}
    return (
      <FileExplorerVirtualRows
        virtualizer={virtualizer}
        inlineInputIndex={input.inlineInputIndex}
        rowProjection={projection}
        inlineInput={input.inlineInput}
        handleInlineSubmit={input.handleInlineSubmit}
        dismissInlineInput={input.dismissInlineInput}
        folderStatusByRelativePath={new Map()}
        statusByRelativePath={new Map()}
        ignoredByRelativePath={new Set()}
        expanded={rendered.expanded}
        loadingDirPaths={rendered.loadingDirPaths}
        selectedPaths={new Set(rendered.selected ? [rendered.selected] : [])}
        activeFileId={null}
        flashingPath={rendered.pane.rowScrolling.flashingPath}
        deleteShortcutLabel="Del"
        onClick={(node) => rendered.handlers.handleClick(node)}
        onDoubleClick={rendered.handlers.handleDoubleClick}
        onViewFile={vi.fn()}
        onContextMenuSelect={vi.fn()}
        onCopyPaths={vi.fn()}
        onStartNew={input.startNew}
        onStartRename={input.startRename}
        onDuplicate={vi.fn()}
        onAddFolderAsProject={vi.fn()}
        canAddFolderAsProject={() => false}
        onOpenInTerminal={vi.fn()}
        onRequestDelete={vi.fn()}
        onCollapseFolderSubtree={vi.fn()}
        onFindInFolder={vi.fn()}
        onMoveDrop={vi.fn()}
        onDragTargetChange={vi.fn()}
        onDragSourceChange={rendered.setDrag}
        onDragExpandDir={rendered.hover.handleDragExpandDir}
        onNativeDragTargetChange={vi.fn()}
        onNativeDragExpandDir={rendered.hover.handleNativeDragExpandDir}
        dropTargetDir={null}
        dragSourcePath={rendered.drag}
        nativeDropTargetDir={null}
      />
    )
  }
  render(<View />)
  return () => current
}

export function initializeExplorerSubscriptions() {
  vi.stubGlobal('api', {
    ...window.api,
    fs: { ...window.api?.fs, onFsChanged: vi.fn(() => vi.fn()) }
  })
}
