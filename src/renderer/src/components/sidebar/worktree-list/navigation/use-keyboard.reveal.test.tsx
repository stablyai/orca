// @vitest-environment happy-dom
import { act, useRef, useState, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useStore } from 'zustand'
import { useVirtualizer } from '@tanstack/react-virtual'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createSetRenamingWorktreeId } from '@/store/slices/worktrees/session/worktree-slice-lookups'
import { createUIStore } from '@/store/slices/ui-slice-test-harness'
import type { AppState } from '@/store/types'
import {
  folderWorkspaceToWorktree,
  getFolderWorkspaceHostIdentity
} from '../../../../../../shared/folder-workspace-worktree'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/host-section-rows'
import { useSidebarRevealHighlight } from './use-reveal-highlight'
import { useSidebarRevealRequests } from './use-reveal-requests'
import { repo, worktree } from '../../worktree-list-groups-test-fixtures'
import type { WorktreeItemRow } from '../listing/renderable-rows'
import { buildRenderableRows } from '../listing/renderable-rows'
import { getWorktreeOptionId } from '../rows/option-dom'
import { usePendingSidebarReveal } from './use-pending-reveal'
import { useWorktreeListKeyboardNavigation } from './use-keyboard'

let store: ReturnType<typeof createUIStore>
const activate = vi.hoisted(() => vi.fn())
const folderActivate = vi.hoisted(() => vi.fn())
vi.mock('@/store', async () => {
  const { useStore } = await import('zustand')
  return {
    useAppStore: Object.assign((selector: (s: AppState) => unknown) => useStore(store, selector), {
      getState: () => store.getState()
    })
  }
})
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: activate,
  activateAndRevealFolderWorkspace: folderActivate
}))
vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => vi.fn()
}))
const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError } }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function row(id: string, rowKey: string, remote = true): WorktreeItemRow {
  return {
    type: 'item',
    rowKey,
    sectionKey: 'repo:repo-1',
    repo,
    worktree: { ...worktree, id, ...(remote ? { hostId: 'ssh:other' as const } : {}) },
    depth: id === 'child' ? 1 : 0,
    groupDepth: 0,
    isLastLineageChild: false,
    lineageChildCount: id === 'parent' && remote ? 1 : 0
  }
}
const local = row('parent', 'local-parent', false)
const pinned = { ...row('parent', 'pinned-parent'), sectionKey: 'pinned' }
const parent = row('parent', 'remote-parent')
const child = row('child', 'remote-child')
const baseRows = [row('a', 'a'), local, pinned, parent, child]
let rows: HostSectionRow[]
let renderRows: ReturnType<typeof buildRenderableRows>
let worktrees = baseRows.map((item) => item.worktree)
let repoMap = new Map([[repo.id, repo]])
const worktreeMap = new Map(worktrees.map((item) => [item.id, item]))
const frames = new Map<number, FrameRequestCallback>()
let frameId = 0
const flash = vi.fn()
const toggle = vi.fn()
const filter = vi.fn()
let mountOnStage: boolean
let hideTarget: boolean
const persist = vi.fn().mockResolvedValue(undefined)
let pendingArgs: Parameters<typeof usePendingSidebarReveal>[0]
let folderWorkspaces: Parameters<typeof usePendingSidebarReveal>[0]['folderWorkspaces'] = []
let projectGroups: Parameters<typeof usePendingSidebarReveal>[0]['projectGroups'] = []
let projectGrouping: Parameters<typeof usePendingSidebarReveal>[0]['projectGrouping']
let extraOptions: WorktreeItemRow[] = []
let beforeEffects: (() => void) | null = null
const noop = () => {}
let root: Root
let container: HTMLDivElement
let list: HTMLDivElement
let initiallyMounted: boolean
let activeId: string
let activeHost: 'local' | 'ssh:other'

function Probe() {
  const groupBy = useStore(store, (s) => s.groupBy)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(initiallyMounted)
  const pending = useStore(store, (s) => s.pendingRevealWorktree)
  const pendingRow = useStore(store, (s) => s.pendingRevealSidebarRow)
  // Subscribe through the production selectors in both reveal consumers.
  const reveal = useSidebarRevealHighlight()
  useLayoutEffect(() => {
    const callback = beforeEffects
    beforeEffects = null
    callback?.()
  })
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: renderRows.length,
    getScrollElement: () => scrollRef.current,
    initialRect: { width: 300, height: 673 },
    estimateSize: (index) => (index === 3 ? 11800 : index === 2 ? 100 : 50),
    scrollToFn: (offset, { adjustments = 0 }) => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = offset + adjustments
      }
      if (offset > 0 && mountOnStage) {
        setMounted(true)
      }
    }
  })
  const navigationArgs = {
    rows,
    renderRows,
    virtualizer,
    activeWorktreeId: activeId,
    activeWorkspaceExecutionHostId: activeHost,
    pinnedDisplayPolicy: 'duplicate-in-groups' as const,
    scrollRef,
    activeModal: 'none',
    markDirectScrollInput: noop
  }
  const navigation = useWorktreeListKeyboardNavigation(navigationArgs)
  useSidebarRevealRequests({
    groupBy,
    renderedSidebarRowKeys: new Set(),
    hasFilters: true,
    currentSidebarWorktreeId: activeId,
    currentSidebarExecutionHostId: activeHost,
    worktreeMap,
    worktrees,
    folderWorkspaces,
    visibleWorktrees: [],
    visibleFolderWorkspaces: [],
    revealWorkspaceFilters: filter
  })
  pendingArgs = {
    pendingRevealWorktree: pending,
    pendingRevealSidebarRow: pendingRow,
    clearPendingRevealWorktreeId: store.getState().clearPendingRevealWorktreeId,
    clearPendingRevealSidebarRow: store.getState().clearPendingRevealSidebarRow,
    agentSendTargetWorktreeId: null,
    renderRows,
    virtualizer,
    scrollRef,
    worktrees,
    folderWorkspaces,
    repoMap,
    worktreeMap,
    worktreeLineageById: {},
    collapsedGroups: store.getState().collapsedGroups,
    toggleGroup: (key) => {
      toggle(key)
      store.getState().toggleCollapsedGroup(key)
    },
    groupBy,
    pinnedDisplayPolicy: 'duplicate-in-groups',
    defaultHostId: 'local',
    prCache: null,
    workspaceStatuses: [],
    settings: null,
    projectGroups,
    projectGrouping,
    flashRevealedRow: (key) => {
      flash(key)
      reveal.flashRevealedRow(key)
    },
    markRevealScroll: noop,
    schedulePendingRevealFrame: reveal.schedulePendingRevealFrame,
    cancelPendingRevealFrames: reveal.cancelPendingRevealFrames
  }
  usePendingSidebarReveal(pendingArgs)
  const option = (
    item: WorktreeItemRow,
    start: number,
    end: number,
    children?: React.ReactNode
  ) => (
    <div
      key={item.rowKey}
      id={getWorktreeOptionId(item.rowKey)}
      role="option"
      aria-selected={false}
      data-worktree-id={item.worktree.id}
      data-worktree-row-key={item.rowKey}
      ref={(node) => {
        if (node) {
          node.getBoundingClientRect = () =>
            new DOMRect(0, start - list.scrollTop, 300, end - start)
        }
      }}
    >
      <div data-worktree-context-menu-scope>
        <div data-worktree-card-surface>{children}</div>
      </div>
    </div>
  )
  return (
    <div
      ref={scrollRef}
      data-worktree-sidebar
      role="listbox"
      tabIndex={0}
      onKeyDown={navigation.handleContainerKeyDown}
    >
      {extraOptions.map((item) => option(item, 900, 1020))}
      {option(local, 2000, 2120)}
      {option(pinned, 4000, 4120)}
      {mounted &&
        !hideTarget &&
        option(
          parent,
          200,
          12000,
          <div
            data-worktree-lineage-children
            ref={(node) => {
              if (node) {
                node.getBoundingClientRect = () => new DOMRect(0, 320 - list.scrollTop, 300, 11680)
              }
            }}
          >
            {option(child, 900, 1020)}
          </div>
        )}
    </div>
  )
}

function press(repeat: boolean) {
  act(() =>
    list.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        code: 'ArrowDown',
        repeat,
        bubbles: true,
        cancelable: true
      })
    )
  )
}
function frame() {
  act(() => {
    // Newly scheduled callbacks belong to the next frame.
    const pendingFrames = [...frames]
    for (const [id, callback] of pendingFrames) {
      frames.delete(id)
      callback(0)
    }
  })
}
function expectVisible(item: WorktreeItemRow, end: number) {
  const option = document.getElementById(getWorktreeOptionId(item.rowKey))!
  expect(option.getBoundingClientRect().top).toBeGreaterThanOrEqual(0)
  expect(end - list.scrollTop).toBeLessThanOrEqual(673)
}

beforeEach(() => {
  vi.clearAllMocks()
  frames.clear()
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++frameId, callback)
    return frameId
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id)
  })
  store = createUIStore()
  store.setState({
    setRenamingWorktreeId: createSetRenamingWorktreeId(store.setState, store.getState),
    renamingWorktreeId: null
  })
  store.setState({
    activeWorktreeId: 'parent',
    sidebarBody: 'workspaces',
    collapsedGroups: new Set(['all'])
  })
  store.setState({ groupBy: 'none' })
  Object.defineProperty(window, 'api', { configurable: true, value: { ui: { set: persist } } })
  mountOnStage = true
  hideTarget = false
  rows = baseRows
  folderWorkspaces = []
  projectGroups = []
  projectGrouping = undefined
  extraOptions = []
  beforeEffects = null
  worktrees = baseRows.map((item) => item.worktree)
  repoMap = new Map([[repo.id, repo]])
  renderRows = buildRenderableRows(rows)
  initiallyMounted = true
  activeId = 'parent'
  activeHost = 'local'
  store.setState({ activeWorktreeId: activeId })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})
function render() {
  store.setState({ activeWorktreeId: activeId })
  act(() => root.render(<Probe />))
  const element = container.firstElementChild
  if (!(element instanceof HTMLDivElement)) {
    throw new Error('Missing list')
  }
  list = element
  Object.defineProperties(list, {
    clientHeight: { value: 673 },
    scrollHeight: { value: 12000 }
  })
  list.getBoundingClientRect = () => new DOMRect(0, 0, 300, 673)
  list.scrollTo = (options?: ScrollToOptions | number) => {
    if (typeof options === 'object') {
      list.scrollTop = options.top ?? 0
    }
  }
}

it.each([false, true])('reveals the exact host and natural parent with repeat=%s', (repeat) => {
  render()
  press(repeat)
  frame()
  expectVisible(parent, 320)
  expect(list.scrollTop).toBe(0)
  expect(store.getState().pendingRevealWorktree).toBeNull()
  expect(toggle).not.toHaveBeenCalled()
  expect(filter).not.toHaveBeenCalled()
  expect(activate).toHaveBeenCalledTimes(repeat ? 0 : 1)
})

it.each([false, true])('reveals the selected child inside its lineage with repeat=%s', (repeat) => {
  activeHost = 'ssh:other'
  render()
  press(repeat)
  frame()
  expectVisible(child, 1020)
  expect(list.scrollTop).toBe(347)
  expect(store.getState().pendingRevealWorktree).toBeNull()
})

it.each([
  ['parent', false],
  ['parent', true],
  ['child', false],
  ['child', true]
] as const)(
  'completes an initially unmounted %s reveal after virtual staging (repeat=%s)',
  (target, repeat) => {
    initiallyMounted = false
    if (target === 'child') {
      activeHost = 'ssh:other'
    }
    render()
    press(repeat)
    frame()
    expect(list.scrollTop).toBeGreaterThan(10000)
    frame()
    frame()
    expectVisible(target === 'parent' ? parent : child, target === 'parent' ? 320 : 1020)
  }
)

it('keeps the last held preview visible and commits that exact child on keyup', () => {
  render()
  press(true)
  press(true)
  frame()
  expectVisible(child, 1020)
  expect(activate).not.toHaveBeenCalled()
  act(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown' })))
  expect(activate).toHaveBeenCalledWith(
    'child',
    expect.objectContaining({ executionHostId: 'ssh:other', revealInSidebar: false })
  )
})

function request(rowKey = parent.rowKey, options = {}) {
  store.getState().revealWorktreeInSidebar('parent', { rowKey, behavior: 'auto', ...options })
}
function drain() {
  for (let i = 0; i < 20 && frames.size; i++) {
    frame()
  }
}

it('retires a vanished occurrence quietly and bounds a present target that never mounts', () => {
  initiallyMounted = false
  mountOnStage = false
  render()
  press(true)
  drain()
  expect(store.getState().pendingRevealWorktree).toBeNull()
  act(() => {
    request()
    rows = [local]
    renderRows = buildRenderableRows(rows)
    root.render(<Probe />)
  })
  drain()
  expect(store.getState().pendingRevealWorktree).toBeNull()
  expect(toastError).not.toHaveBeenCalled()
  expect(toggle).not.toHaveBeenCalled()
})

it.each(['workspace', 'header'] as const)(
  'supersedes an old preview with a newer %s before cleanup',
  (kind) => {
    render()
    act(() => request(child.rowKey, { highlight: true, beginRename: true }))
    const old = store.getState().pendingRevealWorktree
    const callback = [...frames.values()][0]!
    // Deliver before passive cleanup: current store identity must already revoke the old callback.
    act(() => {
      if (kind === 'workspace') {
        request(parent.rowKey)
      } else {
        store.getState().revealSidebarRow(local.rowKey, { behavior: 'auto' })
      }
      callback(0)
      store.getState().clearPendingRevealWorktreeId(old)
    })
    expect(list.scrollTop).toBe(0)
    expect(flash).not.toHaveBeenCalled()
    expect(store.getState().renamingWorktreeId).toBeNull()
    drain()
    expect(list.scrollTop).toBe(kind === 'workspace' ? 0 : 1447)
    expect(store.getState().pendingRevealWorktree).toBeNull()
    expect(store.getState().pendingRevealSidebarRow).toBeNull()
  }
)

it('retires an old header, rejects stale preprocessing, and gives a same-key request a fresh lifetime', () => {
  render()
  beforeEffects = () => request(child.rowKey)
  act(() => store.getState().revealSidebarRow('repo:missing'))
  drain()
  expect(persist).not.toHaveBeenCalled()
  expect(filter).not.toHaveBeenCalled()
  expect(list.scrollTop).toBe(347)
  mountOnStage = false
  hideTarget = true
  const stage = vi.spyOn(pendingArgs.virtualizer, 'scrollToIndex')
  for (const attempts of [8, 2]) {
    const previous = store.getState().pendingRevealWorktree
    act(() => request(child.rowKey))
    const current = store.getState().pendingRevealWorktree
    expect(current).not.toBe(previous)
    stage.mockClear()
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) {
        frame() // Retry tick schedules the next reveal frame without staging.
        expect(stage).toHaveBeenCalledTimes(attempt - 1)
      }
      frame()
      expect(stage).toHaveBeenCalledTimes(attempt)
      expect(store.getState().pendingRevealWorktree).toBe(current)
    }
  }
  expect(list.scrollTop).toBeGreaterThan(10000)
  hideTarget = false
  act(() => root.render(<Probe />))
  drain()
  expect(store.getState().pendingRevealWorktree).toBeNull()
  expectVisible(child, 1020)
  expect(list.scrollTop).toBe(866)
  expect(toastError).not.toHaveBeenCalled()
})

it('keeps explicit unhighlighted expansion, mounted rename and highlight outcomes', () => {
  render()
  rows = [...baseRows, { type: 'header', key: 'repo:repo-1', count: 2, icon: { kind: 'project' } }]
  renderRows = buildRenderableRows(rows)
  extraOptions = [{ ...local, rowKey: 'repo:repo-1' }]
  act(() => store.getState().revealSidebarRow('repo:repo-1', { highlight: false }))
  expect(persist).toHaveBeenCalledWith({ groupBy: 'repo', collapsedGroups: [] })
  drain()
  expect(store.getState().pendingRevealSidebarRow).toBeNull()
  expect(list.scrollTop).toBe(347)
  expect(flash).not.toHaveBeenCalled()
  act(() =>
    store.getState().revealWorktreeInSidebar('parent', {
      executionHostId: 'ssh:other',
      behavior: 'auto',
      beginRename: true,
      highlight: true
    })
  )
  drain()
  expect(store.getState().pendingRevealWorktree).toBeNull()
  expect(flash).toHaveBeenCalledWith(parent.rowKey)
  expect(store.getState().renamingWorktreeId).toEqual({
    worktreeId: 'parent',
    rowKey: parent.rowKey
  })
})

it.each([false, true])(
  'keeps a visible pinned occurrence and no disclosure with repeat=%s',
  (repeat) => {
    rows = [local, pinned]
    renderRows = buildRenderableRows(rows)
    render()
    press(repeat)
    drain()
    expectVisible(pinned, 4120)
    expect(list.scrollTop).toBe(3447)
    expect([...store.getState().collapsedGroups]).toEqual(['all'])
    expect(persist).not.toHaveBeenCalled()
    expect(toggle).not.toHaveBeenCalled()
    expect(filter).not.toHaveBeenCalled()
  }
)

it.each([false, true])(
  'carries the actual qualified folder key through activation/commit repeat=%s',
  (repeat) => {
    const group = {
      id: 'g',
      name: 'g',
      parentPath: null,
      parentGroupId: null,
      createdFrom: 'manual' as const,
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 0,
      updatedAt: 0
    }
    const folder = {
      id: 'f',
      projectGroupId: 'g',
      name: 'f',
      folderPath: '/tmp/f',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      createdAt: 0,
      updatedAt: 0
    }
    const twins: FolderWorkspace[] = [folder, { ...folder, executionHostId: 'ssh:other' }]
    rows = twins.map((folderWorkspace) => ({
      type: 'folder-workspace',
      key: 'render-model-only',
      folderWorkspace,
      projectGroup: group,
      depth: 0,
      groupDepth: 0
    }))
    extraOptions = twins.map((f) => ({
      ...local,
      worktree: folderWorkspaceToWorktree(f),
      rowKey: getFolderWorkspaceHostIdentity(f)
    }))
    activeId = 'folder:f'
    renderRows = buildRenderableRows(rows)
    render()
    press(repeat)
    drain()
    if (repeat) {
      act(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown' })))
    }
    expect(folderActivate).toHaveBeenCalledWith('f', {
      navigationIntent: 'user-open',
      executionHostId: 'ssh:other',
      revealInSidebar: false
    })
    expectVisible(extraOptions[1]!, 1020)
    expect(store.getState().pendingRevealWorktree).toBeNull()
  }
)

it.each([10, 100])('visits zero hidden records in the real key/reveal chain with N=%s', (size) => {
  let visits = 0
  const counted = <T,>(values: T[]): T[] => {
    values.forEach((value, index) => {
      Object.defineProperty(values, index, {
        get() {
          visits++
          return value
        }
      })
    })
    return values
  }
  worktrees = counted(Array.from({ length: size }, (_, i) => ({ ...worktree, id: `hidden${i}` })))
  folderWorkspaces = counted(
    Array.from({ length: size }, (_, i) => ({
      id: `hidden${i}`,
      projectGroupId: 'g',
      name: 'hidden',
      folderPath: '/tmp/hidden',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      createdAt: 0,
      updatedAt: 0
    }))
  )
  projectGroups = counted(
    Array.from({ length: size }, (_, i) => ({
      id: `hidden${i}`,
      name: 'hidden',
      parentPath: null,
      parentGroupId: null,
      createdFrom: 'manual' as const,
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 0,
      updatedAt: 0
    }))
  )
  projectGrouping = {
    projects: counted(
      Array.from({ length: size }, (_, i) => ({
        id: `p${i}`,
        displayName: 'hidden',
        badgeColor: '',
        sourceRepoIds: [],
        createdAt: 0,
        updatedAt: 0
      }))
    ),
    projectHostSetups: counted(
      Array.from({ length: size }, (_, i) => ({
        id: `s${i}`,
        projectId: `p${i}`,
        hostId: 'local' as const,
        repoId: repo.id,
        path: '/tmp/hidden',
        displayName: 'hidden',
        setupState: 'ready' as const,
        setupMethod: 'legacy-repo' as const,
        createdAt: 0,
        updatedAt: 0
      }))
    )
  }
  for (const prefix of ['repo:', 'project-group:']) {
    const selected = { ...pinned, rowKey: `${prefix}selected` }
    rows = [local, selected]
    extraOptions = [selected]
    renderRows = buildRenderableRows(rows)
    render()
    visits = 0
    for (const repeat of [false, true]) {
      press(repeat)
      drain()
    }
    act(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown' })))
    expectVisible(selected, 1020)
    act(() => {
      request(selected.rowKey)
      store.setState({ groupBy: 'repo' })
      rows = [local]
      renderRows = buildRenderableRows(rows)
      root.render(<Probe />)
    })
    frame()
    expect(visits).toBe(0)
    expect(store.getState().pendingRevealWorktree).toBeNull()
    expect(persist).not.toHaveBeenCalled()
    expect(toggle).not.toHaveBeenCalled()
    expect(filter).not.toHaveBeenCalled()
    act(() => root.render(null))
  }
})

it('cancels a queued older row-family frame while preserving the new workspace frame', () => {
  render()
  act(() => store.getState().revealSidebarRow(local.rowKey))
  const oldIds = [...frames.keys()]
  expect(oldIds).toHaveLength(1)
  act(() => request(child.rowKey))
  expect(oldIds.every((id) => !frames.has(id))).toBe(true)
  expect(window.cancelAnimationFrame).toHaveBeenCalledWith(oldIds[0])
  expect(frames.size).toBe(1)
  drain()
  expectVisible(child, 1020)
  expect(store.getState().pendingRevealSidebarRow).toBeNull()
  expect(store.getState().pendingRevealWorktree).toBeNull()
})

it('keeps repo-owned host identity through held preview and activation', () => {
  const selected: WorktreeItemRow = {
    ...pinned,
    rowKey: 'repo-owned-parent',
    worktree: { ...pinned.worktree, hostId: undefined },
    repo: { ...repo, executionHostId: 'ssh:other' }
  }
  activeId = 'a'
  rows = [row('a', 'a', false), selected]
  extraOptions = [selected]
  renderRows = buildRenderableRows(rows)
  render()
  press(true)
  expect(store.getState().pendingRevealWorktree?.rowKey).toBe(selected.rowKey)
  drain()
  expectVisible(selected, 1020)
  act(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown' })))
  expect(activate).toHaveBeenCalledWith(
    'parent',
    expect.objectContaining({ executionHostId: 'ssh:other' })
  )
})
