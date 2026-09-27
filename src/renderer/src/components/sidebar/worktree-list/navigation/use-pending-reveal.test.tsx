// @vitest-environment happy-dom
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { getWorktreeOptionId } from '../rows/option-dom'
import { StrictMode } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pendingRevealFixture } from './pending-reveal-test-fixture'
import { usePendingSidebarReveal } from './use-pending-reveal'

const store = vi.hoisted(() => {
  const state: {
    pendingRevealWorktree: unknown
    pendingRevealSidebarRow: unknown
    renamingWorktreeId: unknown
    setRenamingWorktreeId: ReturnType<typeof vi.fn>
  } = {
    pendingRevealWorktree: null,
    pendingRevealSidebarRow: null,
    renamingWorktreeId: null,
    setRenamingWorktreeId: vi.fn()
  }
  return state
})
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: typeof store) => unknown) => selector(store), {
    getState: () => store
  })
}))
afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  store.pendingRevealWorktree = null
  store.pendingRevealSidebarRow = null
  store.renamingWorktreeId = null
  store.setRenamingWorktreeId.mockReset()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

function mount(kind: 'worktree' | 'row') {
  const f = pendingRevealFixture(kind)
  store.pendingRevealWorktree = f.args.pendingRevealWorktree
  store.pendingRevealSidebarRow = f.args.pendingRevealSidebarRow
  const hook = renderHook(usePendingSidebarReveal, { initialProps: f.args })
  return { ...f, hook }
}

describe('pending reveal continuity', () => {
  it.each(['worktree', 'row'] as const)(
    'retains one %s completion through repeated sidebar updates',
    (kind) => {
      const now = vi.spyOn(window.performance, 'now').mockReturnValue(0)
      const f = mount(kind)
      act(f.frame)
      for (let index = 0; index < 16; index++) {
        now.mockReturnValue(300 + index * 90)
        f.hook.rerender({
          ...f.args,
          renderRows: [...f.args.renderRows],
          worktrees: [...f.args.worktrees],
          repoMap: new Map()
        })
        act(f.frame)
      }
      expect(f.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 9_500, behavior: 'smooth' })
      now.mockReturnValue(2_001)
      act(f.frame)
      expect(f.scrollTo).toHaveBeenCalledOnce()
      expect(f.args.flashRevealedRow).not.toHaveBeenCalled()
      expect(f.args.clearPendingRevealWorktreeId).not.toHaveBeenCalled()
      expect(f.args.clearPendingRevealSidebarRow).not.toHaveBeenCalled()
      f.container.scrollTop = 9_500
      f.state.settling = false
      act(f.frame)
      act(f.frame)
      expect(f.args.flashRevealedRow).toHaveBeenCalledExactlyOnceWith('target-row')
      expect(
        kind === 'worktree'
          ? f.args.clearPendingRevealWorktreeId
          : f.args.clearPendingRevealSidebarRow
      ).toHaveBeenCalledOnce()
      expect(store.setRenamingWorktreeId).toHaveBeenCalledTimes(kind === 'worktree' ? 1 : 0)
    }
  )

  it.each(['worktree', 'row'] as const)(
    'preserves interruption across %s dependency cleanup',
    (kind) => {
      const f = mount(kind)
      act(f.frame)
      f.state.interrupted = true
      f.hook.rerender({ ...f.args, renderRows: [...f.args.renderRows] })
      act(f.frame)
      expect(f.scrollTo).toHaveBeenCalledOnce()
      expect(f.args.flashRevealedRow).not.toHaveBeenCalled()
      expect(
        kind === 'worktree'
          ? f.args.clearPendingRevealWorktreeId
          : f.args.clearPendingRevealSidebarRow
      ).toHaveBeenCalledOnce()
    }
  )
  it.each(['worktree', 'row'] as const)(
    'uses current %s callbacks while retaining the original owner',
    (kind) => {
      const f = mount(kind)
      act(f.frame)
      const flash = vi.fn()
      const clear = vi.fn()
      const schedule = vi.fn(f.args.schedulePendingRevealFrame)
      f.hook.rerender({
        ...f.args,
        flashRevealedRow: flash,
        clearPendingRevealWorktreeId: clear,
        clearPendingRevealSidebarRow: clear,
        schedulePendingRevealFrame: schedule
      })
      f.state.settling = false
      act(f.frame)
      act(f.frame)
      expect(f.scrollTo).toHaveBeenCalledTimes(2)
      expect(flash).toHaveBeenCalledOnce()
      expect(clear).toHaveBeenCalledOnce()
      expect(schedule).toHaveBeenCalled()
      expect(f.args.flashRevealedRow).not.toHaveBeenCalled()
      expect(f.args.clearPendingRevealWorktreeId).not.toHaveBeenCalled()
      expect(f.args.clearPendingRevealSidebarRow).not.toHaveBeenCalled()
    }
  )

  it.each(['rename', 'highlight'] as const)(
    'does not clear a reentrant replacement during %s',
    (action) => {
      const f = mount('worktree')
      const replacement = { ...f.args.pendingRevealWorktree, worktreeId: 'other' }
      if (action === 'rename') {
        store.setRenamingWorktreeId.mockImplementationOnce(() => {
          store.pendingRevealWorktree = replacement
        })
      } else {
        vi.mocked(f.args.flashRevealedRow).mockImplementationOnce(() => {
          store.pendingRevealWorktree = replacement
        })
      }
      act(f.frame)
      f.state.settling = false
      act(f.frame)
      act(f.frame)
      expect(store.pendingRevealWorktree).toBe(replacement)
      expect(f.args.clearPendingRevealWorktreeId).not.toHaveBeenCalled()
      if (action === 'rename') {
        expect(f.args.flashRevealedRow).not.toHaveBeenCalled()
      }
    }
  )

  it.each(['worktree', 'row'] as const)(
    'cancels %s work after unmount without clearing the request',
    (kind) => {
      const f = mount(kind)
      act(f.frame)
      f.hook.unmount()
      f.state.settling = false
      act(f.frame)
      expect(f.frames).toHaveLength(0)
      expect(f.scrollTo).toHaveBeenCalledOnce()
      expect(f.args.flashRevealedRow).not.toHaveBeenCalled()
      expect(store.setRenamingWorktreeId).toHaveBeenCalledTimes(kind === 'worktree' ? 1 : 0)
    }
  )

  it('does not replay a dismissed rename when a new reveal owner mounts', () => {
    const f = mount('worktree')
    const request = f.args.pendingRevealWorktree
    store.setRenamingWorktreeId.mockImplementation((next) => {
      store.renamingWorktreeId = next
    })
    act(f.frame)
    expect(store.setRenamingWorktreeId).toHaveBeenCalledOnce()
    store.renamingWorktreeId = null

    f.hook.unmount()
    f.frames.splice(0)
    expect(store.pendingRevealWorktree).toBe(request)

    const remounted = renderHook(usePendingSidebarReveal, { initialProps: f.args })
    act(f.frame)
    expect(store.setRenamingWorktreeId).toHaveBeenCalledOnce()
    expect(store.renamingWorktreeId).toBeNull()
    f.state.settling = false
    act(f.frame)
    act(f.frame)
    expect(f.args.clearPendingRevealWorktreeId).toHaveBeenCalledOnce()
    remounted.unmount()
  })

  it('admits a fresh rename request after an earlier request was consumed', () => {
    const f = mount('worktree')
    act(f.frame)
    const current = f.args.pendingRevealWorktree
    if (!current) {
      throw new Error('expected rename request')
    }
    const replacement = { ...current }
    store.pendingRevealWorktree = replacement
    f.hook.rerender({ ...f.args, pendingRevealWorktree: replacement })
    act(f.frame)
    expect(store.setRenamingWorktreeId).toHaveBeenCalledTimes(2)
  })

  it('does not revive old frames under StrictMode replay', () => {
    const f = pendingRevealFixture('worktree')
    store.pendingRevealWorktree = f.args.pendingRevealWorktree
    store.pendingRevealSidebarRow = null
    renderHook(usePendingSidebarReveal, { initialProps: f.args, wrapper: StrictMode })
    act(f.frame)
    expect(f.scrollTo).toHaveBeenCalledOnce()
    f.state.settling = false
    act(f.frame)
    act(f.frame)
    expect(f.args.clearPendingRevealWorktreeId).toHaveBeenCalledOnce()
    expect(store.setRenamingWorktreeId).toHaveBeenCalledOnce()
  })

  it.each(['worktree', 'row'] as const)(
    'releases a detached %s target without claiming a replacement node',
    (kind) => {
      const f = mount(kind)
      act(f.frame)
      const replacement = f.element.cloneNode(true)
      f.element.replaceWith(replacement)
      f.hook.rerender({ ...f.args, renderRows: [...f.args.renderRows] })
      act(f.frame)
      expect(f.args.flashRevealedRow).not.toHaveBeenCalled()
      expect(store.setRenamingWorktreeId).toHaveBeenCalledTimes(kind === 'worktree' ? 1 : 0)
      expect(
        kind === 'worktree'
          ? f.args.clearPendingRevealWorktreeId
          : f.args.clearPendingRevealSidebarRow
      ).toHaveBeenCalledOnce()
      expect(f.frames).toHaveLength(0)
    }
  )

  it.each(['worktree', 'row'] as const)(
    'uses a fresh request object for same-target %s replacement',
    (kind) => {
      const f = mount(kind)
      act(f.frame)
      const next = {
        ...f.args,
        pendingRevealWorktree: f.args.pendingRevealWorktree
          ? { ...f.args.pendingRevealWorktree }
          : null,
        pendingRevealSidebarRow: f.args.pendingRevealSidebarRow
          ? { ...f.args.pendingRevealSidebarRow }
          : null
      }
      store.pendingRevealWorktree = next.pendingRevealWorktree
      store.pendingRevealSidebarRow = next.pendingRevealSidebarRow
      f.hook.rerender(next)
      act(f.frame)
      expect(f.scrollTo).toHaveBeenCalledTimes(2)
      f.state.settling = false
      act(f.frame)
      act(f.frame)
      expect(f.args.flashRevealedRow).toHaveBeenCalledOnce()
    }
  )

  it.each(['worktree', 'row'] as const)(
    'fences a %s completion replaced by the other request kind',
    (kind) => {
      const f = mount(kind)
      act(f.frame)
      const other = pendingRevealFixture(kind === 'worktree' ? 'row' : 'worktree')
      other.container.remove()
      store.pendingRevealWorktree = other.args.pendingRevealWorktree
      store.pendingRevealSidebarRow = other.args.pendingRevealSidebarRow
      f.hook.rerender({
        ...f.args,
        pendingRevealWorktree: other.args.pendingRevealWorktree,
        pendingRevealSidebarRow: other.args.pendingRevealSidebarRow
      })
      f.state.settling = false
      act(f.frame)
      expect(f.args.flashRevealedRow).toHaveBeenCalledOnce()
      expect(
        kind === 'worktree'
          ? f.args.clearPendingRevealWorktreeId
          : f.args.clearPendingRevealSidebarRow
      ).not.toHaveBeenCalled()
    }
  )

  it('re-admits after scroll-root detach cancels the registered frame chain', () => {
    const f = mount('worktree')
    act(f.frame)
    act(() => f.hook.result.current())
    f.frames.splice(0)
    f.args.scrollRef.current = null
    f.hook.rerender({ ...f.args, scrollElement: null })
    f.args.scrollRef.current = f.container
    f.hook.rerender({ ...f.args, scrollElement: f.container })
    act(f.frame)
    expect(f.scrollTo).toHaveBeenCalledTimes(2)
    expect(store.setRenamingWorktreeId).toHaveBeenCalledOnce()
    f.state.settling = false
    act(f.frame)
    act(f.frame)
    expect(f.args.clearPendingRevealWorktreeId).toHaveBeenCalledOnce()
  })

  it.each(['worktree', 'row'] as const)(
    'bounds %s staging retries and resets them for an explicit replacement',
    (kind) => {
      const f = mount(kind)
      f.element.remove()
      for (let index = 0; index < 20; index++) {
        act(f.frame)
      }
      expect(f.args.virtualizer.scrollToIndex).toHaveBeenCalledTimes(9)
      expect(f.frames).toHaveLength(0)
      const next = {
        ...f.args,
        pendingRevealWorktree: f.args.pendingRevealWorktree
          ? { ...f.args.pendingRevealWorktree }
          : null,
        pendingRevealSidebarRow: f.args.pendingRevealSidebarRow
          ? { ...f.args.pendingRevealSidebarRow }
          : null
      }
      store.pendingRevealWorktree = next.pendingRevealWorktree
      store.pendingRevealSidebarRow = next.pendingRevealSidebarRow
      f.hook.rerender(next)
      act(f.frame)
      expect(f.frames).toHaveLength(1)
      f.container.append(f.element)
      act(f.frame)
      act(f.frame)
      expect(f.scrollTo).toHaveBeenCalledOnce()
    }
  )

  it('reads rows and virtualizer from the same current preparation snapshot', () => {
    const f = mount('worktree')
    f.element.remove()
    const alternate = pendingRevealFixture('worktree')
    alternate.container.remove()
    const next = {
      ...f.args,
      virtualizer: alternate.args.virtualizer,
      renderRows: [
        { type: 'header' as const, key: 'header', label: 'Header', count: 1, tone: '' },
        ...f.args.renderRows
      ]
    }
    f.hook.rerender(next)
    act(f.frame)
    expect(f.args.virtualizer.scrollToIndex).not.toHaveBeenCalled()
    expect(alternate.args.virtualizer.scrollToIndex).toHaveBeenCalledExactlyOnceWith(1, {
      align: 'auto',
      behavior: 'auto'
    })
  })

  it('handles synchronous visible completion without stranding the next request', () => {
    const f = mount('worktree')
    f.container.scrollTop = 9_500
    f.state.settling = false
    act(f.frame)
    expect(f.args.clearPendingRevealWorktreeId).toHaveBeenCalledOnce()
    const next = {
      ...f.args,
      pendingRevealWorktree: { worktreeId: 'target', behavior: 'auto' as const, highlight: true }
    }
    store.pendingRevealWorktree = next.pendingRevealWorktree
    f.hook.rerender(next)
    act(f.frame)
    expect(f.args.clearPendingRevealWorktreeId).toHaveBeenCalledTimes(2)
    expect(f.frames).toHaveLength(0)
  })
  it('replaces a same-ID request on another host without landing the old host row', () => {
    const f = mount('worktree')
    act(f.frame)
    const firstRow = f.args.renderRows[0]
    if (firstRow.type !== 'item') {
      throw new Error('expected item')
    }
    const remoteRow = {
      ...firstRow,
      rowKey: 'remote-target',
      worktree: { ...firstRow.worktree, hostId: 'ssh:remote' as const }
    }
    const remote = document.createElement('div')
    remote.id = getWorktreeOptionId(remoteRow.rowKey)
    remote.dataset.worktreeRowKey = remoteRow.rowKey
    remote.getBoundingClientRect = () => new DOMRect(0, 100, 200, 100)
    f.container.append(remote)
    const request = {
      worktreeId: 'target',
      executionHostId: 'ssh:remote' as const,
      behavior: 'smooth' as const,
      highlight: true
    }
    store.pendingRevealWorktree = request
    f.state.settling = false
    f.hook.rerender({
      ...f.args,
      pendingRevealWorktree: request,
      renderRows: [firstRow, remoteRow],
      worktrees: [firstRow.worktree, remoteRow.worktree]
    })
    act(f.frame)
    expect(f.args.flashRevealedRow).toHaveBeenCalledExactlyOnceWith('remote-target')
    expect(store.setRenamingWorktreeId).toHaveBeenCalledExactlyOnceWith({
      worktreeId: 'target',
      rowKey: 'target-row'
    })
    expect(f.scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'auto' })
  })
  it.each([undefined, 'ssh:box'] as const)(
    'keeps a folder workspace reveal alive across folder-list updates (%s)',
    (executionHostId) => {
      const f = pendingRevealFixture('worktree')
      const folder = {
        id: 'folder',
        executionHostId,
        projectGroupId: 'project',
        name: 'Folder',
        folderPath: '/workspace/folder',
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
      const project = {
        id: 'project',
        name: 'Project',
        parentPath: '/workspace',
        parentGroupId: null,
        createdFrom: 'manual' as const,
        tabOrder: 0,
        isCollapsed: false,
        color: null,
        createdAt: 0,
        updatedAt: 0
      }
      const key = folderWorkspaceKey(folder.id)
      const rowKey = `${executionHostId ?? 'local'}|${key}`
      f.element.id = getWorktreeOptionId(rowKey)
      f.element.dataset.worktreeRowKey = rowKey
      f.args.pendingRevealWorktree = {
        worktreeId: key,
        executionHostId,
        behavior: 'smooth',
        highlight: true
      }
      f.args.worktrees = []
      f.args.folderWorkspaces = [folder]
      f.args.projectGroups = [project]
      f.args.renderRows = [
        {
          type: 'folder-workspace',
          key,
          folderWorkspace: folder,
          projectGroup: project,
          depth: 0,
          groupDepth: 0
        }
      ]
      if (executionHostId) {
        const localFolder = { ...folder, executionHostId: 'local' as const }
        f.args.folderWorkspaces = [localFolder, ...f.args.folderWorkspaces]
        f.args.renderRows = [
          {
            type: 'folder-workspace',
            key,
            folderWorkspace: localFolder,
            projectGroup: project,
            depth: 0,
            groupDepth: 0
          },
          ...f.args.renderRows
        ]
        const localElement = document.createElement('div')
        localElement.id = getWorktreeOptionId(`local|${key}`)
        localElement.getBoundingClientRect = () => new DOMRect(0, 0, 200, 100)
        f.container.prepend(localElement)
      }
      store.pendingRevealWorktree = f.args.pendingRevealWorktree
      store.pendingRevealSidebarRow = null
      const hook = renderHook(usePendingSidebarReveal, { initialProps: f.args })
      act(f.frame)
      hook.rerender({
        ...f.args,
        folderWorkspaces: f.args.folderWorkspaces.map((workspace) => ({ ...workspace })),
        renderRows: [...f.args.renderRows]
      })
      act(f.frame)
      expect(f.scrollTo).toHaveBeenCalledOnce()
      expect(f.scrollTo).toHaveBeenCalledWith({ top: 9500, behavior: 'smooth' })
      f.state.settling = false
      act(f.frame)
      act(f.frame)
      expect(f.args.flashRevealedRow).toHaveBeenCalledExactlyOnceWith(rowKey)
    }
  )
})
