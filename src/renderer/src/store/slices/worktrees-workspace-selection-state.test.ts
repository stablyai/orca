import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import {
  registerPersistentWebview,
  unregisterPersistentWebview
} from '../../components/browser-pane/host-guest/webview-registry'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import { makeDetectedResult } from './worktrees-detected-listing-fixtures'
import {
  createWebview,
  makeFolderWorkspace,
  makeLineage,
  makeWorktree
} from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from './worktrees-slice-test-harness'

const requestWorktreeBaseFallbackNotice = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  }
}))

vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice
}))

beforeEach(resetWorktreeSliceModuleMemory)

describe('folder workspace lookups', () => {
  it('returns a stable synthetic worktree for repeated folder workspace lookups', () => {
    const store = createTestStore()
    const folderWorkspace = makeFolderWorkspace()
    store.setState({ folderWorkspaces: [folderWorkspace] } as Partial<AppState>)

    const first = store.getState().getKnownWorktreeById(folderWorkspaceKey(folderWorkspace.id))
    const second = store.getState().getKnownWorktreeById(folderWorkspaceKey(folderWorkspace.id))

    expect(second).toBe(first)
    expect(first).toMatchObject({
      id: folderWorkspaceKey(folderWorkspace.id),
      displayName: folderWorkspace.name,
      path: folderWorkspace.folderPath
    })
  })
})

describe('setActiveWorktree focus handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    mockApi.ephemeralVm.cancelProvision.mockResolvedValue({ cancelled: true })
    mockApi.ephemeralVm.cleanup.mockResolvedValue({})
  })

  it('moves focus out of a registered webview before switching worktrees', () => {
    const store = createTestStore()
    const current = makeWorktree({ id: 'repo1::/path/current', repoId: 'repo1' })
    const next = makeWorktree({ id: 'repo1::/path/next', repoId: 'repo1' })
    const webview = createWebview()
    const focusRenderer = vi.fn(() => {
      expect(store.getState().activeWorktreeId).toBe(current.id)
    })
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
    const testWindow = globalThis.window as unknown as { focus?: () => void }
    const previousFocus = testWindow.focus

    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { activeElement: webview }
    })
    testWindow.focus = focusRenderer
    registerPersistentWebview('page-1', webview)

    try {
      store.setState({
        worktreesByRepo: { repo1: [current, next] },
        activeWorktreeId: current.id,
        reconcileWorktreeTabModel: vi.fn(() => ({
          activeRenderableTabId: null,
          renderableTabCount: 0
        })),
        refreshGitHubForWorktreeIfStale: vi.fn()
      } as unknown as Partial<AppState>)

      store.getState().setActiveWorktree(next.id)

      expect(webview.blur).toHaveBeenCalledTimes(1)
      expect(focusRenderer).toHaveBeenCalledTimes(1)
      expect(store.getState().activeWorktreeId).toBe(next.id)
    } finally {
      unregisterPersistentWebview('page-1')
      if (previousDocument) {
        Object.defineProperty(globalThis, 'document', previousDocument)
      } else {
        delete (globalThis as unknown as { document?: unknown }).document
      }
      if (previousFocus) {
        testWindow.focus = previousFocus
      } else {
        delete testWindow.focus
      }
    }
  })
})

describe('markWorktreeVisited', () => {
  it('is monotonic: an older timestamp does not regress the stored value', () => {
    const store = createTestStore()
    store.getState().markWorktreeVisited('wt-1', 1000)
    expect(store.getState().lastVisitedAtByWorktreeId['wt-1']).toBe(1000)

    store.getState().markWorktreeVisited('wt-1', 500)
    expect(store.getState().lastVisitedAtByWorktreeId['wt-1']).toBe(1000)

    store.getState().markWorktreeVisited('wt-1', 1000)
    expect(store.getState().lastVisitedAtByWorktreeId['wt-1']).toBe(1000)

    store.getState().markWorktreeVisited('wt-1', 2000)
    expect(store.getState().lastVisitedAtByWorktreeId['wt-1']).toBe(2000)
  })

  it('seedActiveWorktreeLastVisitedIfMissing seeds only when missing', () => {
    const store = createTestStore()
    store.setState({
      activeWorktreeId: 'wt-1',
      lastVisitedAtByWorktreeId: {}
    } as Partial<AppState>)
    store.getState().seedActiveWorktreeLastVisitedIfMissing()
    expect(store.getState().lastVisitedAtByWorktreeId['wt-1']).toBeTypeOf('number')

    const existing = store.getState().lastVisitedAtByWorktreeId['wt-1']
    store.getState().seedActiveWorktreeLastVisitedIfMissing()
    expect(store.getState().lastVisitedAtByWorktreeId['wt-1']).toBe(existing)
  })

  it('pruneLastVisitedTimestamps drops entries for unknown worktree IDs within hydrated repos', () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/a', repoId: 'repo1', path: '/a' })
    store.setState({
      worktreesByRepo: { repo1: [wt] },
      lastVisitedAtByWorktreeId: { 'repo1::/a': 100, 'repo1::/gone': 200 }
    } as Partial<AppState>)
    store.getState().pruneLastVisitedTimestamps()
    expect(store.getState().lastVisitedAtByWorktreeId).toEqual({ 'repo1::/a': 100 })
  })

  it('pruneLastVisitedTimestamps preserves entries for not-yet-hydrated repos (e.g. SSH pre-connect)', () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/a', repoId: 'repo1', path: '/a' })
    store.setState({
      worktreesByRepo: { repo1: [wt] },
      lastVisitedAtByWorktreeId: { 'repo1::/a': 100, 'ssh-repo::/b': 200 }
    } as Partial<AppState>)
    store.getState().pruneLastVisitedTimestamps()
    expect(store.getState().lastVisitedAtByWorktreeId).toEqual({
      'repo1::/a': 100,
      'ssh-repo::/b': 200
    })
  })

  it('pruneLastVisitedTimestamps clears a stale activeWorktreeId gone from a hydrated repo', () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/a', repoId: 'repo1', path: '/a' })
    store.setState({
      worktreesByRepo: { repo1: [wt] },
      activeWorktreeId: 'repo1::/gone',
      lastVisitedAtByWorktreeId: {}
    } as Partial<AppState>)
    store.getState().pruneLastVisitedTimestamps()
    expect(store.getState().activeWorktreeId).toBeNull()
  })

  it('pruneLastVisitedTimestamps keeps a live activeWorktreeId and defers unhydrated repos', () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/a', repoId: 'repo1', path: '/a' })
    store.setState({
      worktreesByRepo: { repo1: [wt] },
      activeWorktreeId: 'repo1::/a'
    } as Partial<AppState>)
    store.getState().pruneLastVisitedTimestamps()
    expect(store.getState().activeWorktreeId).toBe('repo1::/a')

    // A pointer into a not-yet-hydrated (e.g. SSH pre-connect) repo is deferred.
    store.setState({ activeWorktreeId: 'ssh-repo::/b' } as Partial<AppState>)
    store.getState().pruneLastVisitedTimestamps()
    expect(store.getState().activeWorktreeId).toBe('ssh-repo::/b')
  })

  it('pruneLastVisitedTimestamps defers when the detected list is non-authoritative', () => {
    const store = createTestStore()
    store.setState({
      worktreesByRepo: { repo1: [] },
      detectedWorktreesByRepo: {
        repo1: makeDetectedResult('repo1', [], {
          authoritative: false,
          source: 'metadata-fallback'
        })
      },
      lastVisitedAtByWorktreeId: { 'repo1::/hidden': 100 }
    } as Partial<AppState>)

    store.getState().pruneLastVisitedTimestamps()

    expect(store.getState().lastVisitedAtByWorktreeId).toEqual({ 'repo1::/hidden': 100 })
  })

  it('pruneLastVisitedTimestamps defers an empty list with no detected record (unhydrated shape)', () => {
    const store = createTestStore()
    store.setState({
      worktreesByRepo: { repo1: [] },
      lastVisitedAtByWorktreeId: { 'repo1::/hidden': 100 }
    } as Partial<AppState>)

    store.getState().pruneLastVisitedTimestamps()

    // An empty list is the not-yet-hydrated shape, not an authoritative "no worktrees",
    // so focus-recency is kept until an authoritative scan lands.
    expect(store.getState().lastVisitedAtByWorktreeId).toEqual({ 'repo1::/hidden': 100 })
  })

  it('pruneLastVisitedTimestamps clears the derived worktree-scoped active workspace key with a stale active worktree', () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/a', repoId: 'repo1', path: '/a' })
    store.setState({
      worktreesByRepo: { repo1: [wt] },
      activeWorktreeId: 'repo1::/gone',
      activeWorkspaceKey: worktreeWorkspaceKey('repo1::/gone'),
      activeWorkspaceExecutionHostId: 'local',
      lastVisitedAtByWorktreeId: {}
    } as Partial<AppState>)

    store.getState().pruneLastVisitedTimestamps()

    expect(store.getState().activeWorktreeId).toBeNull()
    // The derived workspace key would keep the phantom workspace selected, so it goes too.
    expect(store.getState().activeWorkspaceKey).toBeNull()
    expect(store.getState().activeWorkspaceExecutionHostId).toBeNull()
  })

  it('pruneLastVisitedTimestamps preserves a folder-scoped active workspace key when the active worktree is stale', () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/a', repoId: 'repo1', path: '/a' })
    store.setState({
      worktreesByRepo: { repo1: [wt] },
      activeWorktreeId: 'repo1::/gone',
      activeWorkspaceKey: folderWorkspaceKey('folder-1'),
      activeWorkspaceExecutionHostId: 'local',
      lastVisitedAtByWorktreeId: {}
    } as Partial<AppState>)

    store.getState().pruneLastVisitedTimestamps()

    expect(store.getState().activeWorktreeId).toBeNull()
    // Folder-scoped keys are never dropped here (matches the removal paths).
    expect(store.getState().activeWorkspaceKey).toBe(folderWorkspaceKey('folder-1'))
    expect(store.getState().activeWorkspaceExecutionHostId).toBeNull()
  })

  it('pruneLastVisitedTimestamps preserves an active workspace key pointing at a different live worktree', () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/a', repoId: 'repo1', path: '/a' })
    store.setState({
      worktreesByRepo: { repo1: [wt] },
      activeWorktreeId: 'repo1::/gone',
      activeWorkspaceKey: worktreeWorkspaceKey('repo1::/a'),
      lastVisitedAtByWorktreeId: {}
    } as Partial<AppState>)

    store.getState().pruneLastVisitedTimestamps()

    expect(store.getState().activeWorktreeId).toBeNull()
    // Only the stale worktree's own derived key is dropped.
    expect(store.getState().activeWorkspaceKey).toBe(worktreeWorkspaceKey('repo1::/a'))
  })

  it('pruneLastVisitedTimestamps clears a legacy unprefixed active workspace key for the stale worktree', () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/a', repoId: 'repo1', path: '/a' })
    store.setState({
      worktreesByRepo: { repo1: [wt] },
      activeWorktreeId: 'repo1::/gone',
      // Sessions predating the `worktree:` prefix stored the bare id (see the purge path).
      activeWorkspaceKey: 'repo1::/gone',
      lastVisitedAtByWorktreeId: {}
    } as unknown as Partial<AppState>)

    store.getState().pruneLastVisitedTimestamps()

    expect(store.getState().activeWorktreeId).toBeNull()
    expect(store.getState().activeWorkspaceKey).toBeNull()
  })
})

describe('setRenamingWorktreeId', () => {
  it('sets and clears the workspace rename signal', () => {
    const store = createTestStore()

    expect(store.getState().renamingWorktreeId).toBeNull()

    store.getState().setRenamingWorktreeId('repo1::/feature')
    expect(store.getState().renamingWorktreeId).toEqual({ worktreeId: 'repo1::/feature' })

    store.getState().setRenamingWorktreeId(null)
    expect(store.getState().renamingWorktreeId).toBeNull()
  })
})

describe('setWorktreesPinnedAndReveal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('pins the focused worktree and reveals it so the viewport follows it into the Pinned section', () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/a', repoId: 'repo1', path: '/a', isPinned: false })
    const reveal = vi.fn()
    store.setState({
      worktreesByRepo: { repo1: [wt] },
      activeWorktreeId: wt.id,
      revealWorktreeInSidebar: reveal
    } as Partial<AppState>)

    store.getState().setWorktreesPinnedAndReveal([wt.id], true)

    expect(store.getState().worktreesByRepo.repo1[0].isPinned).toBe(true)
    expect(reveal).toHaveBeenCalledWith(wt.id, { behavior: 'smooth', highlight: true })
  })

  it('reveals on unpin of the focused worktree so the viewport follows it back to its status group', () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/a', repoId: 'repo1', path: '/a', isPinned: true })
    const reveal = vi.fn()
    store.setState({
      worktreesByRepo: { repo1: [wt] },
      activeWorktreeId: wt.id,
      revealWorktreeInSidebar: reveal
    } as Partial<AppState>)

    store.getState().setWorktreesPinnedAndReveal([wt.id], false)

    expect(store.getState().worktreesByRepo.repo1[0].isPinned).toBe(false)
    expect(reveal).toHaveBeenCalledWith(wt.id, { behavior: 'smooth', highlight: true })
  })

  it('does not scroll when unpinning an unfocused worktree, but still unpins it', () => {
    const store = createTestStore()
    const focused = makeWorktree({ id: 'repo1::/a', repoId: 'repo1', path: '/a', isPinned: false })
    const pinned = makeWorktree({ id: 'repo1::/b', repoId: 'repo1', path: '/b', isPinned: true })
    const reveal = vi.fn()
    store.setState({
      worktreesByRepo: { repo1: [focused, pinned] },
      activeWorktreeId: focused.id,
      revealWorktreeInSidebar: reveal
    } as Partial<AppState>)

    store.getState().setWorktreesPinnedAndReveal([pinned.id], false)

    // The row unpins, but the viewport stays put because it isn't focused.
    expect(store.getState().worktreesByRepo.repo1[1].isPinned).toBe(false)
    expect(reveal).not.toHaveBeenCalled()
  })

  it('does not scroll when pinning an unfocused worktree, but still pins it', () => {
    const store = createTestStore()
    const focused = makeWorktree({ id: 'repo1::/a', repoId: 'repo1', path: '/a', isPinned: false })
    const other = makeWorktree({ id: 'repo1::/b', repoId: 'repo1', path: '/b', isPinned: false })
    const reveal = vi.fn()
    store.setState({
      worktreesByRepo: { repo1: [focused, other] },
      activeWorktreeId: focused.id,
      revealWorktreeInSidebar: reveal
    } as Partial<AppState>)

    store.getState().setWorktreesPinnedAndReveal([other.id], true)

    expect(store.getState().worktreesByRepo.repo1[1].isPinned).toBe(true)
    expect(reveal).not.toHaveBeenCalled()
  })

  it.each([
    { previousPinned: false, nextPinned: true },
    { previousPinned: true, nextPinned: false }
  ])(
    'reveals the focused descendant when changing its unfocused ancestor from $previousPinned to $nextPinned',
    ({ previousPinned, nextPinned }) => {
      const store = createTestStore()
      const parent = makeWorktree({
        id: 'repo1::/parent',
        instanceId: 'parent-instance',
        repoId: 'repo1',
        isPinned: previousPinned
      })
      const child = makeWorktree({
        id: 'repo1::/child',
        instanceId: 'child-instance',
        repoId: 'repo1'
      })
      const reveal = vi.fn()
      store.setState({
        worktreesByRepo: { repo1: [parent, child] },
        worktreeLineageById: {
          [child.id]: makeLineage({ worktreeId: child.id, parentWorktreeId: parent.id })
        },
        activeWorktreeId: child.id,
        revealWorktreeInSidebar: reveal
      } as Partial<AppState>)

      store.getState().setWorktreesPinnedAndReveal([parent.id], nextPinned)

      expect(reveal).toHaveBeenCalledWith(child.id, { behavior: 'smooth', highlight: true })
    }
  )

  it('reveals the focused descendant from embedded legacy lineage', () => {
    const store = createTestStore()
    const parent = makeWorktree({
      id: 'repo1::/parent',
      instanceId: 'parent-instance',
      repoId: 'repo1'
    })
    const child = {
      ...makeWorktree({
        id: 'repo1::/child',
        instanceId: 'child-instance',
        repoId: 'repo1'
      }),
      lineage: makeLineage({ worktreeId: 'repo1::/child', parentWorktreeId: parent.id })
    }
    const reveal = vi.fn()
    store.setState({
      worktreesByRepo: { repo1: [parent, child] },
      activeWorktreeId: child.id,
      revealWorktreeInSidebar: reveal
    } as Partial<AppState>)

    store.getState().setWorktreesPinnedAndReveal([parent.id], true)

    expect(reveal).toHaveBeenCalledWith(child.id, { behavior: 'smooth', highlight: true })
  })

  it('does not reveal through cyclic lineage rejected by rendering', () => {
    const store = createTestStore()
    const first = makeWorktree({
      id: 'repo1::/first',
      instanceId: 'first-instance',
      repoId: 'repo1'
    })
    const second = makeWorktree({
      id: 'repo1::/second',
      instanceId: 'second-instance',
      repoId: 'repo1'
    })
    const reveal = vi.fn()
    store.setState({
      worktreesByRepo: { repo1: [first, second] },
      worktreeLineageById: {
        [first.id]: makeLineage({
          worktreeId: first.id,
          worktreeInstanceId: first.instanceId,
          parentWorktreeId: second.id,
          parentWorktreeInstanceId: second.instanceId
        }),
        [second.id]: makeLineage({
          worktreeId: second.id,
          worktreeInstanceId: second.instanceId,
          parentWorktreeId: first.id,
          parentWorktreeInstanceId: first.instanceId
        })
      },
      activeWorktreeId: second.id,
      revealWorktreeInSidebar: reveal
    } as Partial<AppState>)

    store.getState().setWorktreesPinnedAndReveal([first.id], true)

    expect(reveal).not.toHaveBeenCalled()
  })

  it('does not reveal a focused descendant for duplicate pinned rows', () => {
    const store = createTestStore()
    const parent = makeWorktree({
      id: 'repo1::/parent',
      instanceId: 'parent-instance',
      repoId: 'repo1'
    })
    const child = makeWorktree({
      id: 'repo1::/child',
      instanceId: 'child-instance',
      repoId: 'repo1'
    })
    const reveal = vi.fn()
    store.setState({
      worktreesByRepo: { repo1: [parent, child] },
      worktreeLineageById: {
        [child.id]: makeLineage({ worktreeId: child.id, parentWorktreeId: parent.id })
      },
      activeWorktreeId: child.id,
      settings: { ...store.getState().settings, showPinnedWorktreesInGroups: true },
      revealWorktreeInSidebar: reveal
    } as Partial<AppState>)

    store.getState().setWorktreesPinnedAndReveal([parent.id], true)

    expect(reveal).not.toHaveBeenCalled()
  })

  it('does not reveal through stale lineage', () => {
    const store = createTestStore()
    const parent = makeWorktree({
      id: 'repo1::/parent',
      instanceId: 'replacement-parent-instance',
      repoId: 'repo1'
    })
    const child = makeWorktree({
      id: 'repo1::/child',
      instanceId: 'child-instance',
      repoId: 'repo1'
    })
    const reveal = vi.fn()
    store.setState({
      worktreesByRepo: { repo1: [parent, child] },
      worktreeLineageById: {
        [child.id]: makeLineage({ worktreeId: child.id, parentWorktreeId: parent.id })
      },
      activeWorktreeId: child.id,
      revealWorktreeInSidebar: reveal
    } as Partial<AppState>)

    store.getState().setWorktreesPinnedAndReveal([parent.id], true)

    expect(reveal).not.toHaveBeenCalled()
  })

  it('skips a no-op toggle without requesting a reveal', () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/a', repoId: 'repo1', path: '/a', isPinned: true })
    const reveal = vi.fn()
    store.setState({
      worktreesByRepo: { repo1: [wt] },
      revealWorktreeInSidebar: reveal
    } as Partial<AppState>)

    store.getState().setWorktreesPinnedAndReveal([wt.id], true)

    expect(reveal).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo.repo1[0].isPinned).toBe(true)
  })

  it('does nothing for an unknown worktree id', () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/a', repoId: 'repo1', path: '/a', isPinned: false })
    const reveal = vi.fn()
    store.setState({
      worktreesByRepo: { repo1: [wt] },
      revealWorktreeInSidebar: reveal
    } as Partial<AppState>)

    store.getState().setWorktreesPinnedAndReveal(['repo1::/missing'], true)

    expect(reveal).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo.repo1[0].isPinned).toBe(false)
  })

  it('does nothing for an empty id list', () => {
    const store = createTestStore()
    const reveal = vi.fn()
    store.setState({
      worktreesByRepo: { repo1: [] },
      revealWorktreeInSidebar: reveal
    } as Partial<AppState>)

    store.getState().setWorktreesPinnedAndReveal([], true)

    expect(reveal).not.toHaveBeenCalled()
  })

  it('pins several at once and reveals the focused row even when it is not first', () => {
    const store = createTestStore()
    const alreadyPinned = makeWorktree({
      id: 'repo1::/a',
      repoId: 'repo1',
      path: '/a',
      isPinned: true
    })
    const first = makeWorktree({ id: 'repo1::/b', repoId: 'repo1', path: '/b', isPinned: false })
    const focused = makeWorktree({ id: 'repo1::/c', repoId: 'repo1', path: '/c', isPinned: false })
    const reveal = vi.fn()
    store.setState({
      worktreesByRepo: { repo1: [alreadyPinned, first, focused] },
      activeWorktreeId: focused.id,
      revealWorktreeInSidebar: reveal
    } as Partial<AppState>)

    store.getState().setWorktreesPinnedAndReveal([alreadyPinned.id, first.id, focused.id], true)

    // Only the focused row is revealed, not the first-changed one.
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(reveal).toHaveBeenCalledWith(focused.id, { behavior: 'smooth', highlight: true })
    // Every targeted row is pinned, not just the revealed one; the already-pinned row is untouched.
    expect(store.getState().worktreesByRepo.repo1[0].isPinned).toBe(true)
    expect(store.getState().worktreesByRepo.repo1[1].isPinned).toBe(true)
    expect(store.getState().worktreesByRepo.repo1[2].isPinned).toBe(true)
  })

  it('pins several at once without scrolling when none of them are focused', () => {
    const store = createTestStore()
    const first = makeWorktree({ id: 'repo1::/b', repoId: 'repo1', path: '/b', isPinned: false })
    const second = makeWorktree({ id: 'repo1::/c', repoId: 'repo1', path: '/c', isPinned: false })
    const elsewhere = makeWorktree({
      id: 'repo1::/z',
      repoId: 'repo1',
      path: '/z',
      isPinned: false
    })
    const reveal = vi.fn()
    store.setState({
      worktreesByRepo: { repo1: [first, second, elsewhere] },
      activeWorktreeId: elsewhere.id,
      revealWorktreeInSidebar: reveal
    } as Partial<AppState>)

    store.getState().setWorktreesPinnedAndReveal([first.id, second.id], true)

    expect(reveal).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo.repo1[0].isPinned).toBe(true)
    expect(store.getState().worktreesByRepo.repo1[1].isPinned).toBe(true)
  })
})
