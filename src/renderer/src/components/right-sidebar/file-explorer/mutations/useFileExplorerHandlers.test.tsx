// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { directoryNode, fileNode } from '../tree/file-explorer-tree-node-test-fixtures'
import { useFileExplorerHandlers } from './useFileExplorerHandlers'

const state = vi.hoisted((): { settings: Pick<GlobalSettings, 'fileOpenClickMode'> } => ({
  settings: {}
}))

vi.mock('@/store/index', () => ({
  useAppStore: (selector: (value: typeof state) => unknown) => selector(state)
}))
vi.mock('../navigation/file-explorer-operation-owner', () => ({
  requireMatchingFileExplorerOperationRoute: () => ({ target: { kind: 'local' } }),
  getFileExplorerOwnerUnresolvedMessage: () => 'Unresolved owner'
}))

afterEach(() => {
  cleanup()
  state.settings = {}
})

function renderHandlers() {
  const openFile = vi.fn()
  const setSelectedPath = vi.fn()
  const toggleDir = vi.fn()
  const makePreviewFilePermanent = vi.fn()
  const hook = renderHook(() =>
    useFileExplorerHandlers({
      activeWorktreeId: 'workspace-1',
      openFile,
      makePreviewFilePermanent,
      toggleDir,
      loadDir: async () => true,
      statPath: async () => ({ isDirectory: false }),
      markPathAsDirectory: vi.fn(),
      setSelectedPath,
      scrollRef: { current: null }
    })
  )
  return { ...hook, openFile, setSelectedPath, toggleDir, makePreviewFilePermanent }
}

it('selects on a single click and opens a permanent file when double-click mode is selected', () => {
  state.settings = { fileOpenClickMode: 'double' }
  const { result, openFile, setSelectedPath } = renderHandlers()

  act(() => result.current.handleRowClick(fileNode))
  expect(setSelectedPath).toHaveBeenCalledWith('/repo/src/index.ts')
  expect(openFile).not.toHaveBeenCalled()

  act(() => result.current.handleDoubleClick(fileNode))
  expect(openFile).toHaveBeenCalledWith(
    expect.objectContaining({ filePath: '/repo/src/index.ts', mode: 'edit' }),
    expect.objectContaining({ preview: false, focusEditor: true })
  )
})

it('opens a preview on a single click by default and applies changes to double-click mode', () => {
  const { result, rerender, openFile, makePreviewFilePermanent } = renderHandlers()

  act(() => result.current.handleRowClick(fileNode))
  expect(openFile).toHaveBeenCalledWith(
    expect.objectContaining({ filePath: '/repo/src/index.ts' }),
    expect.objectContaining({ preview: true })
  )
  act(() => result.current.handleDoubleClick(fileNode))
  expect(makePreviewFilePermanent).toHaveBeenCalledWith('/repo/src/index.ts')

  state.settings = { fileOpenClickMode: 'double' }
  rerender()
  openFile.mockClear()
  act(() => result.current.handleRowClick(fileNode))
  expect(openFile).not.toHaveBeenCalled()
  act(() => result.current.handleDoubleClick(fileNode))
  expect(openFile).toHaveBeenCalledWith(
    expect.objectContaining({ filePath: '/repo/src/index.ts' }),
    expect.objectContaining({ preview: false })
  )
})

it('keeps directory clicks and explicit keyboard or menu activation available in double-click mode', () => {
  state.settings = { fileOpenClickMode: 'double' }
  const { result, toggleDir, openFile } = renderHandlers()

  act(() => result.current.handleRowClick(directoryNode))
  expect(toggleDir).toHaveBeenCalledWith('workspace-1', '/repo/src')

  act(() => result.current.handleClick(fileNode))
  expect(openFile).toHaveBeenCalledWith(
    expect.objectContaining({ filePath: '/repo/src/index.ts' }),
    expect.objectContaining({ preview: true })
  )
})
