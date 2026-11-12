// @vitest-environment happy-dom
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useStore } from 'zustand'
import { createUIStore } from '@/store/slices/ui/ui-slice-test-harness'
import type { AppState } from '@/store/types'
import { useSidebarWorktreeSelection } from './use-selection'
import { useWorktreeListKeyboardNavigation } from './use-keyboard'
import { resolveSidebarWorkspaceDeleteIntent } from './sidebar-workspace-delete'
import { getActiveDescendantOptionId } from './active-descendant-option'
import { buildRenderableRows } from '../listing/renderable-rows'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/host-section-rows'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { Repo } from '../../../../../../shared/repo-types'
import { repo, worktree } from '../grouping/worktree-list-groups-test-fixtures'

const deleteOne = vi.hoisted(() => vi.fn())
const deleteBatch = vi.hoisted(() => vi.fn())
const deleteFolder = vi.hoisted(() => vi.fn())
const activate = vi.hoisted(() => vi.fn())
let store: ReturnType<typeof createUIStore>
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (s: AppState) => unknown) => useStore(store, selector), {
    getState: () => store.getState()
  })
}))
vi.mock('../../workspace-actions/deletion/delete-worktree-flow', () => ({
  runWorktreeDelete: deleteOne,
  runWorktreeBatchDelete: deleteBatch
}))
vi.mock('../../workspace-actions/deletion/folder-workspace-delete', () => ({
  deleteFolderWorkspaceUnlessUnsaved: deleteFolder
}))
vi.mock('@/lib/workspace/activation/sidebar-worktree-activation', () => ({
  activateWorktreeFromSidebar: activate
}))
vi.mock('./use-neighbor-prewarm', () => ({ useWorkspaceNeighborPrewarm: () => {} }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const a = { ...worktree, id: 'a', instanceId: 'inc-a', hostId: 'local' as const }
const b = { ...worktree, id: 'b', instanceId: 'inc-b', hostId: 'local' as const }
const twin = { ...b, hostId: 'runtime:other' as const, instanceId: 'inc-remote' }
let items: Worktree[] = [a, b, twin]
let root: Root
let container: HTMLDivElement
let list: HTMLDivElement
let rows: HostSectionRow[]
let activeModal: string
let rowRepo: Repo
let selected: ReturnType<typeof useSidebarWorktreeSelection>
const repoMap = new Map([[repo.id, repo]])
function Probe() {
  const scrollRef = useRef<HTMLDivElement>(null)
  selected = useSidebarWorktreeSelection({
    sectionRows: rows,
    pinnedDisplayPolicy: 'single-location'
  })
  const navigation = useWorktreeListKeyboardNavigation({
    rows,
    activeWorktreeId: 'a',
    activeWorkspaceExecutionHostId: 'local',
    pinnedDisplayPolicy: 'single-location',
    scrollRef,
    activeModal,
    markDirectScrollInput: () => {},
    onKeyboardSelect: selected.selectWorktree,
    focusedWorktree: selected.focusedWorktree,
    focusedWorkspaceExecutionHostId: selected.focusedWorkspaceExecutionHostId,
    resolveDeleteIntent: () =>
      resolveSidebarWorkspaceDeleteIntent({
        selectedWorktrees: selected.selectedWorktrees,
        focusedWorktree: selected.focusedWorktree,
        repoMap
      })
  })
  return (
    <div data-worktree-sidebar-container>
      <div
        data-worktree-sidebar
        role="listbox"
        tabIndex={0}
        ref={scrollRef}
        aria-activedescendant={getActiveDescendantOptionId({
          activeWorktreeId: selected.focusedWorktree?.id ?? 'a',
          activeWorkspaceExecutionHostId: selected.focusedWorkspaceExecutionHostId ?? 'local',
          primaryActiveRowKey: 'row-0',
          pinnedDisplayPolicy: 'single-location',
          renderRows: buildRenderableRows(rows),
          virtualItems: rows.map((_, index) => ({ index }))
        })}
        onKeyDown={navigation.handleContainerKeyDown}
        onKeyUp={navigation.handleContainerKeyUp}
        onBlur={navigation.handleContainerBlur}
      >
        {items.map((item) => (
          <div
            key={`${item.hostId ?? 'local'}|${item.id}`}
            role="option"
            aria-selected={selected.selectedWorktreeIds.has(`${item.hostId ?? 'local'}|${item.id}`)}
            onClick={(e) => selected.updateSelectionForGesture(e, item)}
          >
            {item.id}
          </div>
        ))}
        <input aria-label="Rename" />
      </div>
      <textarea aria-label="Prompt" />
    </div>
  )
}
function render() {
  rows = items.map((item, index) => ({
    type: 'item',
    rowKey: `row-${index}`,
    sectionKey: 'all',
    repo: rowRepo,
    worktree: item,
    depth: 0,
    groupDepth: 0,
    isLastLineageChild: false,
    lineageChildCount: 0
  }))
  act(() => root.render(<Probe />))
  list = container.querySelector('[role=listbox]')!
}
const mod = () => (navigator.userAgent.includes('Mac') ? { metaKey: true } : { ctrlKey: true })
function click(index: number, additive = false) {
  act(() =>
    list.querySelectorAll('[role=option]')[index].dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        ...(additive ? mod() : {})
      })
    )
  )
}
function key(target: Element, init: KeyboardEventInit = {}, type = 'keydown') {
  const event = new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    key: 'Backspace',
    code: 'Backspace',
    shiftKey: true,
    ...mod(),
    ...init
  })
  act(() => target.dispatchEvent(event))
  return event
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  store = createUIStore()
  store.setState({
    keybindings: {},
    activeWorktreeId: 'a',
    deleteStateByWorktreeId: {},
    sshTargetLabels: new Map(),
    repos: [repo],
    worktreesByRepo: { [repo.id]: [a, b, twin] }
  })
  items = [a, b, twin]
  rowRepo = repo
  activeModal = 'none'
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  render()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})
it('deletes the clicked host-qualified row while hover and active workspace differ; repeats act once', () => {
  click(2)
  act(() =>
    list
      .querySelectorAll('[role=option]')[0]
      .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  )
  expect(document.activeElement).toBe(list)
  expect(key(list).defaultPrevented).toBe(true)
  key(list, { repeat: true })
  expect(deleteOne).toHaveBeenCalledTimes(1)
  expect(deleteOne).toHaveBeenCalledWith('b', {
    expectedInstanceId: 'inc-remote',
    expectedHostId: 'runtime:other'
  })
})
it('leaves prompt and rename keys untouched, even with an existing selection', () => {
  click(1)
  for (const field of container.querySelectorAll<HTMLElement>('textarea, input')) {
    act(() => field.focus())
    expect(key(field).defaultPrevented).toBe(false)
  }
  expect(deleteOne).not.toHaveBeenCalled()
})
it('yields during composition and modal ownership, and never substitutes an ineligible row', () => {
  click(1)
  expect(key(list, { isComposing: true }).defaultPrevented).toBe(false)
  activeModal = 'settings'
  render()
  expect(key(list).defaultPrevented).toBe(false)
  activeModal = 'none'
  items = [{ ...b, isMainWorktree: true }]
  render()
  click(0)
  expect(key(list).defaultPrevented).toBe(false)
  items = [b]
  render()
  store.setState({
    deleteStateByWorktreeId: {
      b: { isDeleting: true, error: null, canForceDelete: false, forceDeleteReason: null }
    }
  })
  expect(key(list).defaultPrevented).toBe(false)
  expect(deleteOne).not.toHaveBeenCalled()
})
it('uses explicit arrow preview selection and cancels its pending activation before deletion', () => {
  click(0)
  key(list, {
    key: 'ArrowDown',
    code: 'ArrowDown',
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    repeat: true
  })
  key(list)
  key(list, {}, 'keyup')
  act(() => vi.runOnlyPendingTimers())
  expect(deleteOne).toHaveBeenCalledWith('b', {
    expectedInstanceId: 'inc-b',
    expectedHostId: 'local'
  })
  expect(activate).not.toHaveBeenCalled()
})
it('moves from the explicitly focused row rather than an unrelated active workspace', () => {
  click(2, true)
  expect(list.getAttribute('aria-activedescendant')).toBe('worktree-list-option-row-2')
  key(list, { key: 'ArrowUp', code: 'ArrowUp', shiftKey: false, ctrlKey: false, metaKey: false })
  expect(list.getAttribute('aria-activedescendant')).toBe('worktree-list-option-row-1')
  key(list)
  expect(deleteOne).toHaveBeenCalledWith('b', {
    expectedInstanceId: 'inc-b',
    expectedHostId: 'local'
  })
})
it('does nothing after toggling the final selection off or hiding it', () => {
  click(1)
  click(1, true)
  expect(key(list).defaultPrevented).toBe(false)
  click(2)
  items = [a, b]
  render()
  key(list)
  expect(selected.focusedWorktree).toBeNull()
  expect(deleteOne).not.toHaveBeenCalled()
})
it('uses menu-compatible batches and normalizes a filtered singleton to the single route', () => {
  click(0)
  click(1, true)
  key(list)
  expect(deleteBatch).toHaveBeenCalledWith([
    { id: 'a', instanceId: 'inc-a', hostId: 'local' },
    { id: 'b', instanceId: 'inc-b', hostId: 'local' }
  ])
  items = [{ ...a, isMainWorktree: true }, b]
  render()
  key(list)
  expect(deleteOne).toHaveBeenCalledWith('b', {
    expectedInstanceId: 'inc-b',
    expectedHostId: 'local'
  })
})
it('keeps an unhosted local batch when a sibling SSH repo shares its id', () => {
  const localA = { ...a, hostId: undefined }
  const localB = { ...b, hostId: undefined }
  const sshRepo = { ...repo, connectionId: 'direct' }
  store.setState({ repos: [repo, sshRepo] })
  const intent = resolveSidebarWorkspaceDeleteIntent({
    selectedWorktrees: [localA, localB],
    focusedWorktree: localB,
    repoMap: new Map([[repo.id, sshRepo]])
  })
  expect(intent).toEqual({
    kind: 'batch',
    worktrees: [
      { id: 'a', instanceId: 'inc-a', hostId: undefined },
      { id: 'b', instanceId: 'inc-b', hostId: undefined }
    ]
  })
})
it('uses the rendered remote repo for unhosted row focus and arrow navigation', () => {
  rowRepo = { ...repo, connectionId: 'direct' }
  items = [
    { ...a, hostId: undefined },
    { ...b, hostId: undefined },
    { ...a, id: 'c', hostId: undefined }
  ]
  render()
  click(1)
  expect(list.getAttribute('aria-activedescendant')).toBe('worktree-list-option-row-1')
  key(list, {
    key: 'ArrowDown',
    code: 'ArrowDown',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false
  })
  expect(selected.focusedWorktree?.id).toBe('c')
  expect(selected.focusedWorkspaceExecutionHostId).toBe('ssh:direct')
  expect(list.getAttribute('aria-activedescendant')).toBe('worktree-list-option-row-2')
})
it('removes a single folder through its own route, not a Git worktree deletion', () => {
  items = [{ ...a, id: 'folder:notes', repoId: 'no-repo' }]
  render()
  click(0)
  key(list)
  expect(deleteFolder).toHaveBeenCalledWith(expect.any(Function), 'notes', 'local')
  expect(deleteOne).not.toHaveBeenCalled()
})
it('falls back to the focused selected row when direct SSH bulk deletion is unsupported', () => {
  items = [a, { ...b, hostId: 'ssh:direct' }]
  render()
  click(0)
  click(1, true)
  key(list)
  expect(deleteOne).toHaveBeenCalledWith('b', {
    expectedInstanceId: 'inc-b',
    expectedHostId: 'ssh:direct'
  })
  expect(deleteBatch).not.toHaveBeenCalled()
})
it('normalizes a single eligible SSH target before considering focused-row bulk fallback', () => {
  items = [
    { ...b, hostId: 'ssh:direct' },
    { ...a, isMainWorktree: true }
  ]
  render()
  click(0)
  click(1, true)
  key(list)
  expect(deleteOne).toHaveBeenCalledWith('b', {
    expectedInstanceId: 'inc-b',
    expectedHostId: 'ssh:direct'
  })
  expect(deleteBatch).not.toHaveBeenCalled()
})
it('never substitutes a focused folder for eligible SSH deletion targets', () => {
  const folder = { ...a, id: 'folder:notes', repoId: 'no-repo' }
  items = [{ ...b, hostId: 'ssh:direct' }, folder]
  render()
  click(0)
  click(1, true)
  key(list)
  expect(deleteOne).toHaveBeenCalledWith('b', {
    expectedInstanceId: 'inc-b',
    expectedHostId: 'ssh:direct'
  })
  vi.clearAllMocks()
  items = [{ ...a, hostId: 'ssh:direct' }, { ...b, hostId: 'ssh:direct' }, folder]
  render()
  click(0)
  click(1, true)
  click(2, true)
  key(list)
  expect(deleteOne).not.toHaveBeenCalled()
  expect(deleteBatch).not.toHaveBeenCalled()
  expect(deleteFolder).not.toHaveBeenCalled()
})
it('keeps custom forward Delete and modifier double-tap scoped to the list', () => {
  act(() =>
    store.setState({ keybindings: { 'workspace.delete': ['Mod+Delete', 'DoubleTap+Shift'] } })
  )
  render()
  click(1)
  key(list, { key: 'Delete', code: 'Delete', shiftKey: false })
  expect(deleteOne).toHaveBeenCalledTimes(1)
  const modifier = {
    key: 'Shift',
    code: 'ShiftLeft',
    shiftKey: true,
    ctrlKey: false,
    metaKey: false,
    altKey: false
  }
  key(list, modifier)
  key(list, { ...modifier, shiftKey: false }, 'keyup')
  key(list, modifier)
  expect(deleteOne).toHaveBeenCalledTimes(2)
  key(list, { ...modifier, shiftKey: false }, 'keyup')
  act(() => container.querySelector('textarea')!.focus())
  key(container.querySelector('textarea')!, modifier)
  expect(deleteOne).toHaveBeenCalledTimes(2)
})
