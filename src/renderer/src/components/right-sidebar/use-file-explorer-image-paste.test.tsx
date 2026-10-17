// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ClipboardImageImport } from '../../../../shared/clipboard-image-import'
import type { TreeNode } from './file-explorer-types'
import { useFileExplorerImagePaste } from './use-file-explorer-image-paste'
import { clearFileExplorerUndoHistory } from './fileExplorerUndoRedo'

const mocks = vi.hoisted(() => ({
  stage: vi.fn(),
  release: vi.fn(),
  importPaths: vi.fn(),
  capture: vi.fn(),
  assertCurrent: vi.fn(),
  error: vi.fn()
}))
vi.mock('@/runtime/runtime-file-import-client', () => ({
  importExternalPathsToRuntime: mocks.importPaths
}))
vi.mock('./file-explorer-operation-owner', () => ({
  captureFileExplorerOperationGuard: mocks.capture
}))
vi.mock('sonner', () => ({ toast: { error: mocks.error } }))

const snapshot = { handle: 'owned-handle', path: '/staging/pasted-image.png' }
const refreshDir = vi.fn().mockResolvedValue(undefined)
const setSelectedPath = vi.fn()
const revealPath = vi.fn()
const owner = { kind: 'local' } as const
const initial = {
  worktreeId: 'folder:notes',
  worktreePath: '/notes',
  displayRootPath: '/notes/images',
  refreshDir,
  setSelectedPath,
  revealPath,
  operationOwner: owner
}
function node(path: string, isDirectory = true): TreeNode {
  return { path, isDirectory, name: 'item', relativePath: 'item', depth: 0, operationOwner: owner }
}
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function setup(selectedNode: TreeNode | null = null) {
  return renderHook((params) => useFileExplorerImagePaste(params), {
    initialProps: { ...initial, selectedNode }
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  refreshDir.mockResolvedValue(undefined)
  mocks.stage.mockResolvedValue(snapshot)
  mocks.release.mockResolvedValue(true)
  mocks.capture.mockImplementation((_id, capturedOwner) => {
    if (capturedOwner?.kind !== 'local') {
      throw new Error('Owner unresolved')
    }
    return {
      route: { target: { kind: 'local' }, expectedExecutionHostId: 'local' },
      assertCurrent: mocks.assertCurrent
    }
  })
  mocks.importPaths.mockImplementation(async (_context, _paths, dir) => ({
    results: [{ status: 'imported', destPath: `${dir}/pasted-image copy.png` }]
  }))
  vi.stubGlobal('api', {
    ui: { stageClipboardImageForImport: mocks.stage, releaseClipboardImageImport: mocks.release }
  })
})
afterEach(async () => {
  clearFileExplorerUndoHistory()
  await Promise.resolve()
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it.each([
  [null, '/notes/images'],
  [node('/notes/images/sub'), '/notes/images/sub'],
  [node('/notes/images/sub/source.jpg', false), '/notes/images/sub']
])('imports into the chosen root, folder or parent folder (%s)', async (selected, destination) => {
  const { result } = setup(selected)
  await act(() => result.current.pasteImage())
  expect(mocks.capture.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.stage.mock.invocationCallOrder[0]
  )
  expect(mocks.importPaths).toHaveBeenCalledWith(
    expect.objectContaining({ worktreeId: 'folder:notes', worktreePath: '/notes' }),
    [snapshot.path],
    destination,
    { assertCurrent: mocks.assertCurrent, requireExistingDestination: true }
  )
  expect(refreshDir).toHaveBeenCalledExactlyOnceWith(destination)
  expect(setSelectedPath).toHaveBeenCalledExactlyOnceWith(`${destination}/pasted-image copy.png`)
  expect(revealPath).toHaveBeenCalledExactlyOnceWith(`${destination}/pasted-image copy.png`)
  expect(mocks.release).not.toHaveBeenCalled()
})

it('uses an explicit context-menu target instead of the current selection', async () => {
  const { result } = setup(node('/notes/images/selected'))
  await act(() => result.current.pasteImage(node('/notes/images/context')))
  expect(mocks.importPaths.mock.calls[0][2]).toBe('/notes/images/context')
  await act(() => result.current.pasteImage(null))
  expect(mocks.importPaths.mock.calls[1][2]).toBe('/notes/images')
})

it('handles Windows paths without losing the real workspace root', async () => {
  const { result } = renderHook(() =>
    useFileExplorerImagePaste({
      ...initial,
      worktreePath: 'C:\\Notas',
      displayRootPath: 'C:\\Notas\\Imagens',
      selectedNode: node('C:\\Notas\\Imagens\\a.jpg', false)
    })
  )
  await act(() => result.current.pasteImage())
  expect(mocks.importPaths.mock.calls[0][0].worktreePath).toBe('C:\\Notas')
  expect(mocks.importPaths.mock.calls[0][2]).toBe('C:\\Notas\\Imagens')
})

it.each([
  ['C:/Notas/Imagens', 'C:\\Notas\\Imagens\\pasted-image.png', 'C:/Notas/Imagens/pasted-image.png'],
  [
    'C:\\Notas\\Imagens',
    'C:/Notas/Imagens/pasted-image.png',
    'C:\\Notas\\Imagens\\pasted-image.png'
  ],
  ['/notes/images', '/notes/images/pasted\\image.png', '/notes/images/pasted\\image.png']
])(
  'selects the imported file using the tree path spelling in %s',
  async (root, imported, selected) => {
    mocks.importPaths.mockResolvedValue({ results: [{ status: 'imported', destPath: imported }] })
    const { result } = renderHook(() =>
      useFileExplorerImagePaste({
        ...initial,
        worktreePath: root,
        displayRootPath: root,
        selectedNode: null
      })
    )
    await act(() => result.current.pasteImage())
    expect(setSelectedPath).toHaveBeenCalledExactlyOnceWith(selected)
  }
)

it.each(['hidden', 'outside', 'invalid-root', 'missing-capability', 'missing-release'])(
  'does not stage for %s',
  async (condition) => {
    if (condition === 'missing-capability') {
      vi.stubGlobal('api', { ui: {} })
    }
    if (condition === 'missing-release') {
      vi.stubGlobal('api', { ui: { stageClipboardImageForImport: mocks.stage } })
    }
    const { result } = renderHook(() =>
      useFileExplorerImagePaste({
        ...initial,
        worktreePath: condition === 'hidden' ? null : initial.worktreePath,
        displayRootPath: condition === 'invalid-root' ? '/other' : initial.displayRootPath,
        selectedNode: condition === 'outside' ? node('/notes/elsewhere') : null
      })
    )
    await act(() => result.current.pasteImage())
    expect(mocks.stage).not.toHaveBeenCalled()
    expect(mocks.importPaths).not.toHaveBeenCalled()
  }
)

it('rejects a row with unknown ownership before touching the clipboard', async () => {
  const { result } = setup({ ...node('/notes/images'), operationOwner: undefined })
  await act(() => result.current.pasteImage())
  expect(mocks.stage).not.toHaveBeenCalled()
  expect(mocks.error).toHaveBeenCalledExactlyOnceWith('Owner unresolved')
})

it('leaves non-image clipboard content alone', async () => {
  mocks.stage.mockResolvedValue(null)
  const { result } = setup()
  await act(() => result.current.pasteImage())
  expect(mocks.importPaths).not.toHaveBeenCalled()
  expect(mocks.release).not.toHaveBeenCalled()
  expect(mocks.error).not.toHaveBeenCalled()
})

it('keeps the captured destination and avoids refreshing a different workspace', async () => {
  const stage = deferred<ClipboardImageImport>()
  mocks.stage.mockReturnValue(stage.promise)
  const { result, rerender } = setup(node('/notes/images/sub'))
  let operation: Promise<void> | undefined
  act(() => {
    operation = result.current.pasteImage()
  })
  rerender({
    ...initial,
    worktreeId: 'folder:other',
    worktreePath: '/other',
    displayRootPath: '/other',
    selectedNode: null
  })
  await act(async () => {
    stage.resolve(snapshot)
    await operation
  })
  expect(mocks.importPaths.mock.calls[0][2]).toBe('/notes/images/sub')
  expect(refreshDir).not.toHaveBeenCalled()
  expect(setSelectedPath).not.toHaveBeenCalled()
  expect(mocks.release).toHaveBeenCalledWith(snapshot.handle)
})

it('checks scope again after refreshing the directory', async () => {
  const refresh = deferred<void>()
  refreshDir.mockReturnValue(refresh.promise)
  const { result, rerender } = setup()
  let operation: Promise<void> | undefined
  await act(async () => {
    operation = result.current.pasteImage()
    await Promise.resolve()
  })
  expect(refreshDir).toHaveBeenCalledTimes(1)
  rerender({ ...initial, displayRootPath: '/notes/other', selectedNode: null })
  await act(async () => {
    refresh.resolve()
    await operation
  })
  expect(setSelectedPath).not.toHaveBeenCalled()
  expect(revealPath).not.toHaveBeenCalled()
  expect(mocks.release).not.toHaveBeenCalled()
})

it('releases after an in-flight import finishes even when the tree unmounts', async () => {
  const imported = deferred<{ results: [] }>()
  mocks.importPaths.mockReturnValue(imported.promise)
  const { result, unmount } = setup()
  let operation: Promise<void> | undefined
  await act(async () => {
    operation = result.current.pasteImage()
    await Promise.resolve()
  })
  unmount()
  expect(mocks.release).not.toHaveBeenCalled()
  await act(async () => {
    imported.resolve({ results: [] })
    await operation
  })
  expect(mocks.release).toHaveBeenCalledWith(snapshot.handle)
  expect(refreshDir).not.toHaveBeenCalled()
  expect(setSelectedPath).not.toHaveBeenCalled()
})

it('ignores overlapping calls through import and cleanup, then accepts a new gesture', async () => {
  const released = deferred<boolean>()
  mocks.importPaths.mockResolvedValueOnce({ results: [] })
  mocks.release.mockReturnValueOnce(released.promise)
  const { result } = setup()
  let operation: Promise<void> | undefined
  await act(async () => {
    operation = result.current.pasteImage()
    await result.current.pasteImage()
  })
  expect(result.current.isPastingImage).toBe(true)
  expect(result.current.canPasteImage).toBe(false)
  await act(() => result.current.pasteImage())
  expect(mocks.stage).toHaveBeenCalledTimes(1)
  await act(async () => {
    released.resolve(true)
    await operation
  })
  await act(() => result.current.pasteImage())
  expect(mocks.stage).toHaveBeenCalledTimes(2)
})

it.each(['stage', 'import', 'refresh'])(
  'handles %s rejection and restores availability',
  async (failure) => {
    const error = new Error('Permission denied')
    if (failure === 'stage') {
      mocks.stage.mockRejectedValueOnce(error)
    }
    if (failure === 'import') {
      mocks.importPaths.mockRejectedValueOnce(error)
    }
    if (failure === 'refresh') {
      refreshDir.mockRejectedValueOnce(error)
    }
    const { result } = setup()
    await act(() => result.current.pasteImage())
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith('Permission denied')
    expect(mocks.release).toHaveBeenCalledTimes(failure === 'import' ? 1 : 0)
    expect(result.current.canPasteImage).toBe(true)
  }
)

it.each(['failed', 'skipped'])(
  'reports an import result of %s and releases the snapshot',
  async (status) => {
    mocks.importPaths.mockResolvedValue({
      results: [{ status, reason: 'permission-denied', sourcePath: snapshot.path }]
    })
    const { result } = setup()
    await act(() => result.current.pasteImage())
    expect(mocks.error).toHaveBeenCalledTimes(1)
    expect(setSelectedPath).not.toHaveBeenCalled()
    expect(mocks.release).toHaveBeenCalledWith(snapshot.handle)
  }
)

it('does not turn a successful import into an import error when cleanup fails', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  mocks.release.mockRejectedValueOnce(new Error('Cleanup unavailable'))
  const { result } = setup()
  await act(() => result.current.pasteImage())
  await act(async () => {
    clearFileExplorerUndoHistory()
  })
  expect(setSelectedPath).toHaveBeenCalledTimes(1)
  expect(mocks.error).not.toHaveBeenCalled()
  expect(log).toHaveBeenCalledTimes(1)
  expect(result.current.canPasteImage).toBe(true)
})
