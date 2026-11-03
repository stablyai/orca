// @vitest-environment happy-dom
import {
  trackers,
  read,
  owner,
  listing,
  rootListing,
  deliverRevealScroll,
  settle
} from './file-explorer-reveal-test-fixtures'
import { act, fireEvent, renderHook, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useFileExplorerTree } from './useFileExplorerTree'
import { getExplorerDisplayRootPath } from './file-explorer-display-root'
import {
  gateRead,
  renderInteractionTree,
  useVisibleTree,
  visibleProps
} from './file-explorer-lifecycle-test-support'

it.each(['held-root', 'held-ancestor'] as const)(
  'preserves actual active-file reveal and rendered input during %s, then selects/scrolls after release',
  async (phase) => {
    const current = renderInteractionTree(owner)
    await settle()
    act(() => current().handlers.handleClick(current().rootCache!.children[0]))
    await settle()
    const selectedBeforeReveal = current().selected
    expect(selectedBeforeReveal).toBe('/repo/a')
    const root = gateRead(),
      ancestor = gateRead()
    const calls = read.mock.calls.length
    read.mockImplementation((_id, _root, path) =>
      path === '/repo'
        ? phase === 'held-root'
          ? root.promise
          : Promise.resolve(rootListing())
        : ancestor.promise
    )
    act(() => {
      void current().refreshTree()
    })
    await settle()
    // A valid tab exists before the real activation producer; no focus producer runs during editing.
    act(() => useAppStore.getState().setActiveFile('target', 'wt'))
    await settle()
    const request = useAppStore.getState().pendingExplorerReveal
    const scroll = vi.spyOn(current().pane.rowScrolling.virtualizer, 'scrollToIndex')
    const beforeInteractionPaths = read.mock.calls.slice(calls).map((call) => call[2])
    const source = current().projection.getRowByPath('/repo/a/old.txt')!
    act(() => current().input.startRename(source))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'typed draft' } })
    await act(async () => {
      root.resolve(rootListing())
      ancestor.resolve(listing('target.txt'))
    })
    await settle()
    expect(screen.getByRole('textbox')).toBe(input)
    expect(screen.getByDisplayValue('typed draft')).toBe(input)
    expect(beforeInteractionPaths).toEqual(phase === 'held-root' ? ['/repo'] : ['/repo', '/repo/a'])
    expect(current().projection.hasPath('/repo/a/old.txt')).toBe(true)
    expect(current().projection.hasPath('/repo/a/target.txt')).toBe(false)
    expect(useAppStore.getState().pendingExplorerReveal?.filePath).toBe('/repo/a/target.txt')
    expect(current().selected).toBe(selectedBeforeReveal)
    expect(useAppStore.getState().pendingExplorerReveal).toBe(request)
    expect(current().pane.rowScrolling.flashingPath).toBeNull()
    expect(scroll).not.toHaveBeenCalled()
    read.mockImplementation((_id, _root, path) =>
      Promise.resolve(path === '/repo' ? rootListing() : listing('target.txt'))
    )
    act(() => current().input.dismissInlineInput())
    await settle()
    expect(current().projection.hasPath('/repo/a/old.txt')).toBe(false)
    expect(current().selected).toBe('/repo/a/target.txt')
    await deliverRevealScroll()
    expect(scroll).toHaveBeenCalledWith(current().projection.getIndexByPath('/repo/a/target.txt'), {
      align: 'center'
    })
    expect(useAppStore.getState().pendingExplorerReveal).toBeNull()
    expect(current().pane.rowScrolling.flashingPath).toBeNull()
    expect(read.mock.calls.slice(calls).every((call) => !call[3]?.wakeWslDistro)).toBe(true)
  }
)

it.each([
  ['single', 'before'],
  ['wave', 'before'],
  ['wave', 'ready']
] as const)(
  'joins %s publication (%s subscription), independently of an unrelated held read',
  async (mode, timing) => {
    const expanded = new Set(['/repo/a', '/repo/b'])
    const hook = renderHook(() => useFileExplorerTree('/repo', expanded, 'wt'))
    await act(async () => {
      await hook.result.current.loadDir('/repo', -1, { force: true })
    })
    const a = gateRead(),
      b = gateRead()
    read.mockImplementation((_id, _root, path) =>
      path === '/repo' ? Promise.resolve(rootListing()) : path === '/repo/a' ? a.promise : b.promise
    )
    let refresh!: Promise<unknown>
    act(() => {
      refresh =
        mode === 'single'
          ? hook.result.current.refreshDir('/repo/a')
          : hook.result.current.refreshTree()
    })
    await settle()
    if (timing === 'ready') {
      await act(async () => a.resolve(listing('target.txt')))
    }
    let observed: unknown
    let joined!: Promise<void>
    await act(async () => {
      joined = hook.result.current
        .observeDirForReveal('/repo/a', 0, 'active-file', () => true)
        .then((outcome) => {
          hook.result.current.setDirCache((cache) => {
            observed = { outcome, names: cache['/repo/a']?.children.map((node) => node.name) }
            return cache
          })
        })
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      a.resolve(listing('target.txt'))
      await joined
    })
    expect(observed).toEqual({ outcome: 'refreshed', names: ['target.txt'] })
    expect(hook.result.current.loadingDirPaths.has('/repo/a')).toBe(false)
    expect(read.mock.calls.filter((call) => call[2] === '/repo/a')).toHaveLength(1)
    if (mode === 'wave') {
      expect(hook.result.current.loadingDirPaths.has('/repo/b')).toBe(true)
    }
    await act(async () => {
      b.resolve(listing())
      await refresh
    })
  }
)

it('manual first listing supersedes a queued passive claim without waking or awaiting held unrelated work', async () => {
  const paths = Array.from({ length: 18 }, (_, i) => `/repo/d${i}`)
  const hook = renderHook(() => useFileExplorerTree('/repo', new Set(paths), 'wt'))
  const held = gateRead()
  read.mockImplementation((_id, _root, path) =>
    path === '/repo'
      ? Promise.resolve(rootListing())
      : path === paths.at(-1)
        ? Promise.resolve(listing('target.txt'))
        : held.promise
  )
  act(() => {
    void hook.result.current.refreshTree()
  })
  await settle()
  let outcome: unknown
  await act(async () => {
    outcome = await hook.result.current.observeDirForReveal(paths.at(-1)!, 0, 'manual', () => true)
  })
  expect(outcome).toBe('refreshed')
  expect(hook.result.current.dirCache[paths.at(-1)!].children[0].name).toBe('target.txt')
  expect(read.mock.calls.at(-1)?.[3]?.wakeWslDistro).not.toBe(true)
  act(() => hook.result.current.retireView())
  await act(async () => held.resolve(listing('obsolete.txt')))
})

it('keeps New input through actual parent supersession and a late automatic response', async () => {
  const current = renderInteractionTree(owner)
  await settle()
  act(() => current().handlers.handleClick(current().rootCache!.children[0]))
  await settle()
  const automatic = gateRead(),
    requested = gateRead()
  read
    .mockImplementationOnce(() => automatic.promise)
    .mockImplementationOnce(() => requested.promise)
  act(() => {
    void current().refreshDir('/repo/a')
  })
  act(() => current().input.startNew('file', '/repo/a', 1))
  const input = screen.getByRole('textbox')
  fireEvent.change(input, { target: { value: 'new draft' } })
  expect(read.mock.calls.at(-1)?.[3]?.wakeWslDistro).toBe(true)
  await act(async () => {
    requested.resolve(listing('target.txt'))
  })
  await act(async () => {
    automatic.resolve(listing('obsolete.txt'))
  })
  expect(screen.getByRole('textbox')).toBe(input)
  expect(screen.getByDisplayValue('new draft')).toBe(input)
  expect(current().projection.hasPath('/repo/a/target.txt')).toBe(true)
  expect(current().projection.hasPath('/repo/a/obsolete.txt')).toBe(false)
})

it.each(['replace', 'retire', 'reset', 'new-request'] as const)(
  'promptly retires a joined single read on %s before old transport finishes',
  async (action) => {
    const hook = renderHook(() => useFileExplorerTree('/repo', new Set<string>(), 'wt'))
    await act(async () => {
      await hook.result.current.loadDir('/repo', -1, { force: true })
    })
    const old = gateRead(),
      successor = gateRead()
    read.mockReturnValueOnce(old.promise).mockReturnValueOnce(successor.promise)
    let active = true
    let joined!: Promise<unknown>
    act(() => {
      joined = hook.result.current.observeDirForReveal('/repo/a', 0, 'active-file', () => active)
    })
    await settle()
    if (action === 'replace') {
      act(() => hook.result.current.requestDir('/repo/a'))
    } else if (action === 'reset') {
      act(() => hook.result.current.resetAndLoad())
    } else if (action === 'new-request') {
      active = false
      // The next real request replaces the attempt; no late traversal may advance ancestry.
      act(() => hook.result.current.requestDir('/repo/a'))
    } else {
      act(() => hook.result.current.retireView())
    }
    expect(await joined).toBe('superseded')
    if (action === 'replace' || action === 'new-request') {
      expect(hook.result.current.loadingDirPaths.has('/repo/a')).toBe(true)
      expect(read.mock.calls.at(-1)?.[3]?.wakeWslDistro).toBe(true)
    }
    await act(async () => old.reject(new Error('late old failure')))
    if (action === 'replace' || action === 'new-request') {
      expect(hook.result.current.loadingDirPaths.has('/repo/a')).toBe(true)
    }
    await act(async () => successor.resolve(listing('current.txt')))
    expect(
      hook.result.current.dirCache['/repo/a']?.children.some((node) => node.name === 'obsolete.txt')
    ).not.toBe(true)
  }
)

it('manual producer retains no-wake first-listing permission during protection and flashes the selected result', async () => {
  const current = renderInteractionTree(owner)
  await settle()
  act(() => current().setNative(true))
  expect(current().native).toBe(true)
  const target = gateRead()
  read.mockReturnValueOnce(target.promise)
  const scroll = vi.spyOn(current().pane.rowScrolling.virtualizer, 'scrollToIndex')
  act(() => useAppStore.getState().revealInExplorer('wt', '/repo/a/target.txt'))
  await settle()
  expect(useAppStore.getState().pendingExplorerReveal?.origin).toBe('manual')
  expect(read.mock.calls.at(-1)?.[2]).toBe('/repo/a')
  expect(read.mock.calls.at(-1)?.[3]?.wakeWslDistro).not.toBe(true)
  await act(async () => target.resolve(listing('target.txt')))
  // Run only the reveal scheduling turns, leaving the presentation flash alive.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50)
  })
  expect(current().selected).toBe('/repo/a/target.txt')
  expect(current().pane.rowScrolling.flashingPath).toBe('/repo/a/target.txt')
  expect(scroll).toHaveBeenCalledWith(current().projection.getIndexByPath('/repo/a/target.txt'), {
    align: 'center'
  })
})

it('a newer real manual request wins over the old awaited traversal and its late response', async () => {
  read.mockResolvedValueOnce({
    ...listing(),
    entries: ['a', 'b'].map((name) => ({ name, isDirectory: true, isSymlink: false }))
  })
  const current = renderInteractionTree(owner)
  await settle()
  const old = gateRead()
  let firstA = true
  read.mockImplementation((_id, _root, path) => {
    if (path === '/repo/a' && firstA) {
      firstA = false
      return old.promise
    }
    return Promise.resolve(path === '/repo/b' ? listing('target.txt') : listing())
  })
  act(() => useAppStore.getState().revealInExplorer('wt', '/repo/a/deep/old.txt'))
  await settle()
  const sharedA = trackers[0].get('/repo/a')
  expect(sharedA).toBeDefined()
  const scroll = vi.spyOn(current().pane.rowScrolling.virtualizer, 'scrollToIndex')
  act(() => useAppStore.getState().revealInExplorer('wt', '/repo/b/target.txt'))
  await settle()
  expect(current().selected).toBe('/repo/b/target.txt')
  await deliverRevealScroll()
  expect(scroll).toHaveBeenCalledWith(current().projection.getIndexByPath('/repo/b/target.txt'), {
    align: 'center'
  })
  expect(trackers[0].get('/repo/a')).toBe(sharedA)
  const ancestorReads = read.mock.calls.filter((call) => call[2] === '/repo/a/deep').length
  scroll.mockClear()
  await act(async () => old.resolve(listing('late-old.txt')))
  await settle()
  expect(current().selected).toBe('/repo/b/target.txt')
  expect(current().projection.hasPath('/repo/a/late-old.txt')).toBe(true)
  await deliverRevealScroll()
  expect(scroll).not.toHaveBeenCalled()
  expect(read.mock.calls.filter((call) => call[2] === '/repo/a/deep')).toHaveLength(ancestorReads)
  expect(useAppStore.getState().pendingExplorerReveal).toBeNull()
})

it('hide retires an actual reveal waiting on root; reentry completes the still-current request', async () => {
  const reset = vi.fn(),
    filter = vi.fn()
  const hook = renderHook((props) => useVisibleTree(props, reset, filter, owner), {
    initialProps: visibleProps
  })
  await settle()
  const old = gateRead()
  read.mockReturnValueOnce(old.promise)
  act(() => {
    void hook.result.current.refreshTree()
  })
  act(() => useAppStore.getState().revealInExplorer('wt', '/repo/a/target.txt'))
  await settle()
  hook.rerender({ ...visibleProps, visible: false })
  const reads = read.mock.calls.length
  await act(async () => old.resolve(rootListing()))
  expect(read).toHaveBeenCalledTimes(reads)
  read.mockImplementation((_id, _root, path) =>
    Promise.resolve(path === '/repo' ? rootListing() : listing('target.txt'))
  )
  hook.rerender(visibleProps)
  await settle()
  expect(hook.result.current.selected).toBe('/repo/a/target.txt')
  expect(useAppStore.getState().pendingExplorerReveal).toBeNull()
})

it.each(['held', 'terminal'] as const)(
  'Retry after %s root preserves exactly the supported reveal lifetime',
  async (phase) => {
    const current = renderInteractionTree(owner)
    await settle()
    act(() => current().handlers.handleClick(current().rootCache!.children[0]))
    await settle()
    const old = gateRead()
    read.mockReturnValueOnce(old.promise)
    const before = read.mock.calls.length
    act(() => {
      void current().refreshTree()
    })
    act(() => useAppStore.getState().setActiveFile('target', 'wt'))
    await settle()
    expect(read.mock.calls.slice(before).map((call) => call[2])).toEqual(['/repo'])
    if (phase === 'terminal') {
      await act(async () => old.reject(new Error('offline')))
      await settle()
      expect(useAppStore.getState().pendingExplorerReveal).toBeNull()
      expect(read.mock.calls.slice(before).map((call) => call[2])).toEqual(['/repo'])
    }
    read.mockImplementation((_id, _root, path) =>
      Promise.resolve(path === '/repo' ? rootListing() : listing('target.txt'))
    )
    await act(async () => {
      await current().refreshDir('/repo', { wakeWslDistro: true })
    })
    await settle()
    if (phase === 'terminal') {
      expect(current().selected).not.toBe('/repo/a/target.txt')
      // A new legitimate activation owns a new request; Retry does not resurrect the cleared one.
      act(() =>
        useAppStore.setState((state) => ({
          openFiles: [
            ...state.openFiles,
            { ...state.openFiles[0], id: 'other', filePath: '/repo/a/other.txt' }
          ]
        }))
      )
      act(() => useAppStore.getState().setActiveFile('other', 'wt'))
      await settle()
      act(() => useAppStore.getState().setActiveFile('target', 'wt'))
      await settle()
    }
    expect(current().selected).toBe('/repo/a/target.txt')
    expect(useAppStore.getState().pendingExplorerReveal).toBeNull()
    if (phase === 'held') {
      await act(async () => old.resolve(listing('obsolete-root.txt')))
      expect(current().projection.hasPath('/repo/obsolete-root.txt')).toBe(false)
    }
  }
)

it('actual manual reveal falls back to its existing parent only after the requested listing publishes', async () => {
  const current = renderInteractionTree(owner)
  await settle()
  const target = gateRead()
  read.mockReturnValueOnce(target.promise)
  act(() => useAppStore.getState().revealInExplorer('wt', '/repo/a/missing.txt'))
  await settle()
  expect(useAppStore.getState().pendingExplorerReveal).not.toBeNull()
  expect(current().selected).not.toBe('/repo/a')
  await act(async () => target.resolve(listing('existing.txt')))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50)
  })
  expect(current().selected).toBe('/repo/a')
  expect(current().pane.rowScrolling.flashingPath).toBe('/repo/a')
  expect(useAppStore.getState().pendingExplorerReveal).toBeNull()
})

it('actual manual reveal restores full-root navigation before selecting and scrolling an outside-scope target', async () => {
  useAppStore.setState({ explorerDisplayRootByWorktree: { wt: 'a' } })
  read.mockImplementation((_id, _root, path) =>
    Promise.resolve(
      path === '/repo'
        ? {
            ...rootListing(),
            entries: [
              ...rootListing().entries,
              { name: 'outside.txt', isDirectory: false, isSymlink: false }
            ]
          }
        : listing('old.txt')
    )
  )
  const reset = vi.fn(),
    filter = vi.fn()
  const hook = renderHook(() => {
    const choice = useAppStore((state) => state.explorerDisplayRootByWorktree.wt)
    return useVisibleTree(
      { ...visibleProps, scope: getExplorerDisplayRootPath('/repo', choice)! },
      reset,
      filter,
      owner
    )
  })
  await settle()
  expect(hook.result.current.projection.hasPath('/repo/outside.txt')).toBe(false)
  const scroll = vi.spyOn(hook.result.current.pane.rowScrolling.virtualizer, 'scrollToIndex')
  const reads = read.mock.calls.length
  act(() => useAppStore.getState().revealInExplorer('wt', '/repo/outside.txt'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50)
  })
  expect(useAppStore.getState().explorerDisplayRootByWorktree.wt).toBe('/')
  expect(hook.result.current.selected).toBe('/repo/outside.txt')
  expect(scroll).toHaveBeenCalledWith(
    hook.result.current.projection.getIndexByPath('/repo/outside.txt'),
    { align: 'center' }
  )
  expect(hook.result.current.pane.rowScrolling.flashingPath).toBe('/repo/outside.txt')
  expect(useAppStore.getState().pendingExplorerReveal).toBeNull()
  expect(read).toHaveBeenCalledTimes(reads)
})
