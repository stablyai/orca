// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { createRef } from 'react'
import { useFileExplorerHandlers } from './useFileExplorerHandlers'
import { DIR_TOGGLE_DOUBLE_CLICK_MS } from './file-explorer-dir-toggle-timing'
import type { TreeNode } from './file-explorer-types'

const directoryNode: TreeNode = {
  name: 'components',
  path: '/repo/src/components',
  relativePath: 'src/components',
  isDirectory: true,
  depth: 1
}

const siblingDirectoryNode: TreeNode = {
  name: 'lib',
  path: '/repo/src/lib',
  relativePath: 'src/lib',
  isDirectory: true,
  depth: 1
}

function renderHandlers(toggleDir: (worktreeId: string, dirPath: string) => void) {
  return renderHook(() =>
    useFileExplorerHandlers({
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
    })
  )
}

async function flush(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms)
    await Promise.resolve()
  })
}

describe('deferred directory toggle', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('toggles immediately when the click missed the rename hotspot', async () => {
    const toggleDir = vi.fn()
    const { result } = renderHandlers(toggleDir)

    await act(async () => {
      result.current.handleClick(directoryNode, 'immediate')
      await Promise.resolve()
    })

    expect(toggleDir).toHaveBeenCalledWith('wt-1', directoryNode.path)
  })

  it('holds a filename click back until the double-click window closes', async () => {
    const toggleDir = vi.fn()
    const { result } = renderHandlers(toggleDir)

    await act(async () => {
      result.current.handleClick(directoryNode, 'deferred')
      await Promise.resolve()
    })
    expect(toggleDir).not.toHaveBeenCalled()

    await flush(DIR_TOGGLE_DOUBLE_CLICK_MS)
    expect(toggleDir).toHaveBeenCalledWith('wt-1', directoryNode.path)
  })

  it('never toggles when a second click turns the gesture into a rename', async () => {
    const toggleDir = vi.fn()
    const { result } = renderHandlers(toggleDir)

    await act(async () => {
      result.current.handleClick(directoryNode, 'deferred')
      await Promise.resolve()
    })
    await act(async () => {
      result.current.handleClick(directoryNode, 'skip')
      await Promise.resolve()
    })

    await flush(DIR_TOGGLE_DOUBLE_CLICK_MS * 2)
    expect(toggleDir).not.toHaveBeenCalled()
  })

  it('drops a pending toggle when a rename starts', async () => {
    const toggleDir = vi.fn()
    const { result } = renderHandlers(toggleDir)

    await act(async () => {
      result.current.handleClick(directoryNode, 'deferred')
      await Promise.resolve()
    })
    act(() => result.current.cancelPendingDirToggle())

    await flush(DIR_TOGGLE_DOUBLE_CLICK_MS * 2)
    expect(toggleDir).not.toHaveBeenCalled()
  })

  it('flushes a pending toggle when the next click lands on a different row', async () => {
    const toggleDir = vi.fn()
    const { result } = renderHandlers(toggleDir)

    await act(async () => {
      result.current.handleClick(directoryNode, 'deferred')
      await Promise.resolve()
    })
    // Why: clicking another folder must not silently discard the first folder's
    // expand — only that row's own second click (the rename) may retract it.
    await act(async () => {
      result.current.handleClick(siblingDirectoryNode, 'deferred')
      await Promise.resolve()
    })

    expect(toggleDir).toHaveBeenCalledWith('wt-1', directoryNode.path)

    await flush(DIR_TOGGLE_DOUBLE_CLICK_MS)
    expect(toggleDir).toHaveBeenCalledWith('wt-1', siblingDirectoryNode.path)
    expect(toggleDir).toHaveBeenCalledTimes(2)
  })

  it('drops a pending toggle when the explorer unmounts', async () => {
    const toggleDir = vi.fn()
    const { result, unmount } = renderHandlers(toggleDir)

    await act(async () => {
      result.current.handleClick(directoryNode, 'deferred')
      await Promise.resolve()
    })
    unmount()

    await flush(DIR_TOGGLE_DOUBLE_CLICK_MS * 2)
    expect(toggleDir).not.toHaveBeenCalled()
  })
})
