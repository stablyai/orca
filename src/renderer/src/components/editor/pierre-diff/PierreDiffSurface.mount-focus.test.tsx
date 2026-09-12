// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { FileDiffMetadata } from '@pierre/diffs'
import { PierreDiffSurface } from './PierreDiffSurface'

vi.mock('@pierre/diffs/react', () => ({ FileDiff: () => null }))
vi.mock('./pierre-diff-context-copy', () => ({ installPierreContextualCopy: () => () => {} }))
vi.mock('./use-pierre-diff-find', () => ({
  usePierreDiffFind: () => ({
    searchBar: null,
    handleContainerKeyDown: () => {},
    onPointerDown: () => {},
    onPostRender: () => {},
    onEditChange: () => {}
  })
}))
vi.mock('./use-pierre-diff-note-navigation', () => ({
  usePierreDiffNoteNavigation: () => () => {}
}))
vi.mock('./use-pierre-diff-shift-wheel', () => ({
  usePierreDiffShiftWheel: () => () => {}
}))
vi.mock('./use-pierre-diff-native-view', () => ({
  usePierreDiffNativeView: () => () => {}
}))
const storeState = vi.hoisted(() => ({
  editorFontZoomLevel: 0,
  clearDeliveredDiffComments: () => {},
  activeGroupIdByWorktree: {} as Record<string, string>,
  scrollToDiffCommentId: null as string | null,
  keybindings: {}
}))

vi.mock('@/store', () => {
  const useAppStore = (selector: (s: typeof storeState) => unknown) => selector(storeState)
  useAppStore.getState = () => storeState
  return { useAppStore }
})

const fileDiff = { name: 'file.ts', hunks: [] } as unknown as FileDiffMetadata

function renderSurface(autoFocusHost?: boolean) {
  return render(
    <PierreDiffSurface
      fileDiff={fileDiff}
      sideBySide={false}
      isEditable={false}
      collapseUnchanged
      autoFocusHost={autoFocusHost}
      worktreeId="wt"
      filePath="file.ts"
      comments={[]}
      onDeleteComment={() => {}}
    />
  )
}

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  storeState.activeGroupIdByWorktree = {}
})

it('focuses the keyboard host on mount for the single-file tab', () => {
  const sidebar = document.createElement('button')
  document.body.append(sidebar)
  sidebar.focus()
  expect(document.activeElement).toBe(sidebar)

  const { container } = renderSurface(true)
  const host = container.querySelector<HTMLElement>('[data-editor-keyboard-scope]')
  expect(host).not.toBeNull()
  expect(document.activeElement).toBe(host)
})

it('does not steal focus on mount for combined-diff rows', () => {
  const sidebar = document.createElement('button')
  document.body.append(sidebar)
  sidebar.focus()

  renderSurface()
  expect(document.activeElement).toBe(sidebar)
})

it('does not steal focus from a terminal when a late parse mounts the host', () => {
  const terminal = document.createElement('textarea')
  document.body.append(terminal)
  terminal.focus()
  expect(document.activeElement).toBe(terminal)

  renderSurface(true)
  expect(document.activeElement).toBe(terminal)
})

it('does not steal focus when the surface mounts in a background tab group', () => {
  const sidebar = document.createElement('button')
  document.body.append(sidebar)
  sidebar.focus()

  render(
    <div data-tab-group-body-id="other-group">
      <PierreDiffSurface
        fileDiff={fileDiff}
        sideBySide={false}
        isEditable={false}
        collapseUnchanged
        autoFocusHost
        worktreeId="wt"
        filePath="file.ts"
        comments={[]}
        onDeleteComment={() => {}}
      />
    </div>
  )
  expect(document.activeElement).toBe(sidebar)
})

it('does not steal focus when editability flips after the user left the tab group', () => {
  const sidebar = document.createElement('button')
  document.body.append(sidebar)
  sidebar.focus()
  storeState.activeGroupIdByWorktree = { wt: 'group-a' }

  const view = render(
    <div data-tab-group-body-id="group-a">
      <PierreDiffSurface
        fileDiff={fileDiff}
        sideBySide={false}
        isEditable
        collapseUnchanged
        autoFocusHost
        worktreeId="wt"
        filePath="file.ts"
        comments={[]}
        onDeleteComment={() => {}}
      />
    </div>
  )
  expect(document.activeElement).toBe(sidebar)

  storeState.activeGroupIdByWorktree = { wt: 'group-b' }
  view.rerender(
    <div data-tab-group-body-id="group-a">
      <PierreDiffSurface
        fileDiff={fileDiff}
        sideBySide={false}
        isEditable={false}
        collapseUnchanged
        autoFocusHost
        worktreeId="wt"
        filePath="file.ts"
        comments={[]}
        onDeleteComment={() => {}}
      />
    </div>
  )
  expect(document.activeElement).toBe(sidebar)
})

it('focuses the host when a still-active group becomes read-only', () => {
  const sidebar = document.createElement('button')
  document.body.append(sidebar)
  sidebar.focus()
  storeState.activeGroupIdByWorktree = { wt: 'group-a' }

  const view = render(
    <div data-tab-group-body-id="group-a">
      <PierreDiffSurface
        fileDiff={fileDiff}
        sideBySide={false}
        isEditable
        collapseUnchanged
        autoFocusHost
        worktreeId="wt"
        filePath="file.ts"
        comments={[]}
        onDeleteComment={() => {}}
      />
    </div>
  )
  expect(document.activeElement).toBe(sidebar)

  view.rerender(
    <div data-tab-group-body-id="group-a">
      <PierreDiffSurface
        fileDiff={fileDiff}
        sideBySide={false}
        isEditable={false}
        collapseUnchanged
        autoFocusHost
        worktreeId="wt"
        filePath="file.ts"
        comments={[]}
        onDeleteComment={() => {}}
      />
    </div>
  )
  const host = view.container.querySelector<HTMLElement>('[data-editor-keyboard-scope]')
  expect(host).not.toBeNull()
  expect(document.activeElement).toBe(host)
})
