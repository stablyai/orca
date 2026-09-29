// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { createElement, createRef, type MouseEvent } from 'react'
import { useFileExplorerHandlers } from './useFileExplorerHandlers'
import { useFileExplorerNodeCommands } from './use-file-explorer-node-commands'
import { createFileExplorerRowProjection } from './file-explorer-row-projection'
import { RENAME_HOTSPOT_ATTR } from './file-explorer-dir-toggle-timing'
import type { TreeNode } from './file-explorer-types'

vi.mock('./file-explorer-operation-owner', () => ({
  getFileExplorerOwnerUnresolvedMessage: () => 'unresolved',
  requireMatchingFileExplorerOperationRoute: () => ({ settings: {} })
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector({})
}))
vi.mock('@/components/terminal/terminal-tab-create', () => ({ createNewTerminalTab: vi.fn() }))
vi.mock('./useFileDuplicate', () => ({ useFileDuplicate: () => vi.fn() }))
vi.mock('./useFileExplorerKeys', () => ({ useFileExplorerKeys: vi.fn() }))

const directoryNode: TreeNode = {
  name: 'components',
  path: '/repo/src/components',
  relativePath: 'src/components',
  isDirectory: true,
  depth: 1
}

const fileNode: TreeNode = {
  name: 'index.ts',
  path: '/repo/src/index.ts',
  relativePath: 'src/index.ts',
  isDirectory: false,
  depth: 1
}

const symlinkDirectoryNode: TreeNode = {
  name: 'linked-components',
  path: '/repo/src/linked-components',
  relativePath: 'src/linked-components',
  isDirectory: false,
  isSymlink: true,
  depth: 1
}

function createHandlerParams(toggleDir: (worktreeId: string, dirPath: string) => void) {
  return {
    activeWorktreeId: 'wt-1',
    openFile: vi.fn(),
    makePreviewFilePermanent: vi.fn(),
    toggleDir,
    loadDir: vi.fn().mockResolvedValue(true),
    statPath: vi.fn().mockResolvedValue({ isDirectory: true }),
    authorizeExternalPath: vi.fn(),
    markPathAsDirectory: vi.fn(),
    setSelectedPath: vi.fn(),
    scrollRef: createRef<HTMLDivElement>()
  }
}

function renderHandlers(toggleDir: (worktreeId: string, dirPath: string) => void) {
  const params = createHandlerParams(toggleDir)
  const hook = renderHook(() => useFileExplorerHandlers(params))
  return { ...hook, openFile: params.openFile, setSelectedPath: params.setSelectedPath }
}

// Wires a row like the explorer does so clicks resolve timing in handleRowClick.
function renderRow(node: TreeNode, toggleDir: (worktreeId: string, dirPath: string) => void) {
  const params = createHandlerParams(toggleDir)
  function Row() {
    const { handleClick } = useFileExplorerHandlers(params)
    const { handleRowClick } = useFileExplorerNodeCommands({
      activeWorktreeId: 'wt-1',
      worktreePath: '/repo',
      activeRepo: null,
      containerRef: createRef<HTMLDivElement>(),
      rowProjection: createFileExplorerRowProjection([node]),
      rowExpandedPaths: new Set(),
      selectedPaths: new Set(),
      selectedNode: null,
      selectRowWithModifiers: (target, _event, onReplaceClick) => onReplaceClick(target),
      moveSelection: vi.fn(),
      inlineInput: null,
      startRename: vi.fn(),
      requestDelete: vi.fn(),
      requestDeleteAll: vi.fn(),
      refreshDir: vi.fn().mockResolvedValue(undefined),
      handleClick,
      toggleDir,
      scrollToIndex: vi.fn()
    })
    return createElement(
      'button',
      {
        'data-testid': 'row',
        onClick: (event: MouseEvent<HTMLButtonElement>) => handleRowClick(node, event)
      },
      createElement('span', { [RENAME_HOTSPOT_ATTR]: '', 'data-testid': 'name' }, node.name)
    )
  }
  const view = render(createElement(Row))
  return { ...view, setSelectedPath: params.setSelectedPath }
}

async function clickAndSettle(target: Element, detail: number): Promise<void> {
  await act(async () => {
    fireEvent.click(target, { detail })
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('instant directory toggle', () => {
  afterEach(() => cleanup())

  it('toggles immediately when the click missed the rename hotspot', async () => {
    const toggleDir = vi.fn()
    const { result } = renderHandlers(toggleDir)

    await act(async () => {
      result.current.handleClick(directoryNode, 'immediate')
      await Promise.resolve()
    })

    expect(toggleDir).toHaveBeenCalledWith('wt-1', directoryNode.path)
  })

  it('toggles a filename click immediately, without waiting out the double-click window', async () => {
    vi.useFakeTimers()
    try {
      const toggleDir = vi.fn()
      const { getByTestId } = renderRow(directoryNode, toggleDir)

      await clickAndSettle(getByTestId('name'), 1)

      // Why: no timer may be involved — a delay here is what read as lag on the folder name.
      expect(toggleDir).toHaveBeenCalledWith('wt-1', directoryNode.path)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops only the second click of a double-click rename so the folder does not flip back', async () => {
    const toggleDir = vi.fn()
    const { getByTestId, setSelectedPath } = renderRow(directoryNode, toggleDir)

    await clickAndSettle(getByTestId('name'), 1)
    await clickAndSettle(getByTestId('name'), 2)

    expect(toggleDir).toHaveBeenCalledTimes(1)
    // Why: the rename about to start still needs the row selected.
    expect(setSelectedPath).toHaveBeenLastCalledWith(directoryNode.path)
  })

  it('toggles on both clicks of a double-click outside the filename', async () => {
    const toggleDir = vi.fn()
    const { getByTestId } = renderRow(directoryNode, toggleDir)

    await clickAndSettle(getByTestId('row'), 1)
    await clickAndSettle(getByTestId('row'), 2)

    expect(toggleDir).toHaveBeenCalledTimes(2)
  })

  it('toggles a symlink directory once when the second click is a rename', async () => {
    const toggleDir = vi.fn()
    const { getByTestId, setSelectedPath } = renderRow(symlinkDirectoryNode, toggleDir)

    // Why: both clicks land before the first stat resolves, as in a real double-click.
    await act(async () => {
      fireEvent.click(getByTestId('name'), { detail: 1 })
      fireEvent.click(getByTestId('name'), { detail: 2 })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(toggleDir).toHaveBeenCalledTimes(1)
    expect(toggleDir).toHaveBeenCalledWith('wt-1', symlinkDirectoryNode.path)
    expect(setSelectedPath).toHaveBeenLastCalledWith(symlinkDirectoryNode.path)
  })

  it('keeps opening files on the second click, which is not a directory toggle', async () => {
    const toggleDir = vi.fn()
    const { result, openFile } = renderHandlers(toggleDir)

    await act(async () => {
      result.current.handleClick(fileNode, 'skip')
      await Promise.resolve()
    })

    expect(toggleDir).not.toHaveBeenCalled()
    expect(openFile).toHaveBeenCalledTimes(1)
  })
})
