// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { FileDiffMetadata, PostRenderPhase } from '@pierre/diffs'
import type { PierreDiffInstance } from './PierreDiffSurface'
import { PierreDiffSurface } from './PierreDiffSurface'

const captured = vi.hoisted(() => ({
  options: [] as { onPostRender?: (...args: unknown[]) => void }[]
}))
const consumers = vi.hoisted(() => ({
  height: vi.fn(),
  note: vi.fn(),
  search: vi.fn(),
  wheel: vi.fn(),
  native: vi.fn()
}))

vi.mock('@pierre/diffs/react', () => ({
  FileDiff: (props: { options: { onPostRender?: (...args: unknown[]) => void } }) => {
    captured.options.push(props.options)
    return <div data-testid="file-diff" />
  }
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: object) => unknown) =>
    selector({
      editorFontZoomLevel: 0,
      clearDeliveredDiffComments: vi.fn(),
      activeGroupIdByWorktree: {}
    })
}))
vi.mock('@/components/error-boundaries/RecoverableRenderErrorBoundary', () => ({
  RecoverableRenderErrorBoundary: ({ children }: { children: React.ReactNode }) => children
}))
vi.mock('./use-pierre-diff-find', () => ({
  usePierreDiffFind: () => ({
    searchBar: null,
    handleContainerKeyDown: () => {},
    onPointerDown: () => {},
    onPostRender: (...args: unknown[]) => consumers.search(...args),
    onEditChange: () => {}
  })
}))
vi.mock('./use-pierre-diff-note-navigation', () => ({
  usePierreDiffNoteNavigation: () => consumers.note
}))
vi.mock('./use-pierre-diff-shift-wheel', () => ({
  usePierreDiffShiftWheel: () => consumers.wheel
}))
vi.mock('./use-pierre-diff-native-view', () => ({
  usePierreDiffNativeView: () => consumers.native
}))
vi.mock('./pierre-diff-context-copy', () => ({
  installPierreContextualCopy: () => () => {}
}))

afterEach(() => {
  cleanup()
  captured.options.length = 0
  vi.clearAllMocks()
})

function renderSurface(onPostRender = consumers.height) {
  return render(
    <PierreDiffSurface
      fileDiff={{ name: 'file.ts', hunks: [] } as unknown as FileDiffMetadata}
      sideBySide={false}
      isEditable={false}
      collapseUnchanged
      worktreeId="workspace"
      filePath="file.ts"
      comments={[]}
      onDeleteComment={() => {}}
      onPostRender={onPostRender}
    />
  )
}

it('keeps Pierre onPostRender stable across search-only rerenders and still chains consumers', () => {
  const view = renderSurface()
  const first = captured.options.at(-1)?.onPostRender
  expect(first).toEqual(expect.any(Function))
  const node = document.createElement('div')
  const instance = {} as PierreDiffInstance
  first?.(node, instance, 'mount' as PostRenderPhase)
  expect(consumers.height).toHaveBeenCalledWith(node, 'mount', instance)
  expect(consumers.note).toHaveBeenCalledWith(node, 'mount', instance)
  expect(consumers.search).toHaveBeenCalledWith(node, 'mount', instance)
  expect(consumers.wheel).toHaveBeenCalledWith(node, 'mount', instance)
  expect(consumers.native).toHaveBeenCalledWith(node, 'mount', instance)
  view.rerender(
    <PierreDiffSurface
      fileDiff={{ name: 'file.ts', hunks: [] } as unknown as FileDiffMetadata}
      sideBySide={false}
      isEditable={false}
      collapseUnchanged
      worktreeId="workspace"
      filePath="file.ts"
      comments={[]}
      onDeleteComment={() => {}}
      onPostRender={vi.fn()}
    />
  )
  expect(captured.options.at(-1)?.onPostRender).toBe(first)
  const latestHeight = vi.fn()
  view.rerender(
    <PierreDiffSurface
      fileDiff={{ name: 'file.ts', hunks: [] } as unknown as FileDiffMetadata}
      sideBySide={false}
      isEditable={false}
      collapseUnchanged
      worktreeId="workspace"
      filePath="file.ts"
      comments={[]}
      onDeleteComment={() => {}}
      onPostRender={latestHeight}
    />
  )
  expect(captured.options.at(-1)?.onPostRender).toBe(first)
  first?.(node, instance, 'update' as PostRenderPhase)
  expect(latestHeight).toHaveBeenCalledWith(node, 'update', instance)
  expect(consumers.note).toHaveBeenCalledWith(node, 'update', instance)
  expect(consumers.search).toHaveBeenCalledWith(node, 'update', instance)
  expect(consumers.wheel).toHaveBeenCalledWith(node, 'update', instance)
  expect(consumers.native).toHaveBeenCalledWith(node, 'update', instance)
})
