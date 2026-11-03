// @vitest-environment happy-dom
import {
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
import { useLayoutEffect, useRef } from 'react'
import {
  gateRead,
  renderInteractionTree,
  useVisibleTree,
  visibleProps
} from './file-explorer-lifecycle-test-support'

it('actual manual reveal reads the remaining root page before selecting and centering its target', async () => {
  const more = { after: { name: 'old.txt', isDirectory: false } }
  read.mockResolvedValueOnce({ ...listing('old.txt'), paged: true, more })
  const current = renderInteractionTree(owner, true)
  await settle()
  const scroll = vi.spyOn(current().pane.rowScrolling.virtualizer, 'scrollToIndex')
  const held = gateRead()
  read.mockReturnValueOnce(held.promise)
  act(() => useAppStore.getState().revealInExplorer('wt', '/repo/target.txt'))
  await act(async () => {
    await Promise.resolve()
  })
  expect(read).toHaveBeenLastCalledWith('wt', '/repo', '/repo', {
    paged: true,
    after: more.after
  })
  expect(current().selected).not.toBe('/repo/old.txt')
  expect(useAppStore.getState().pendingExplorerReveal?.filePath).toBe('/repo/target.txt')
  expect(scroll).not.toHaveBeenCalled()
  await act(async () => held.resolve(listing('target.txt')))
  expect(current().selected).toBe('/repo/target.txt')
  expect(useAppStore.getState().pendingExplorerReveal).toBeNull()
  await deliverRevealScroll()
  expect(scroll).toHaveBeenCalledWith(1, { align: 'center' })
  expect(screen.getByText('target.txt').dataset.flashing).toBe('true')
  expect(read).toHaveBeenCalledTimes(2)
})

it.each(['held-root', 'parked-root', 'scoped-root'] as const)(
  'keeps zero-ancestor intent and typed DOM through %s until authoritative release',
  async (phase) => {
    const scoped = phase === 'scoped-root'
    const parent = scoped ? '/repo/a' : '/repo'
    useAppStore.setState((state) => ({
      rightSidebarOpen: true,
      rightSidebarExplorerView: 'files',
      explorerDisplayRootByWorktree: { wt: scoped ? 'a' : '/' },
      openFiles: [{ ...state.openFiles[0], filePath: `${parent}/target.txt` }]
    }))
    read.mockImplementation((_id, _root, path) =>
      Promise.resolve(scoped && path === '/repo' ? rootListing() : listing('old.txt'))
    )
    const current = renderInteractionTree(owner, true)
    await settle()
    expect(current().expanded.size).toBe(0)
    const scroll = vi.spyOn(current().pane.rowScrolling.virtualizer, 'scrollToIndex')
    const held = gateRead()
    read.mockReturnValueOnce(held.promise)
    act(() => {
      void current().refreshDir(parent)
    })
    act(() => useAppStore.getState().setActiveFile('target', 'wt'))
    // Flush the real producer, but hold both the observation and its scroll delivery.
    await act(async () => {
      await Promise.resolve()
    })
    const source = current().projection.getRowByPath(`${parent}/old.txt`)!
    act(() => current().input.startRename(source))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'root draft' } })
    if (phase === 'parked-root') {
      act(() => {
        void current().refreshDir(parent)
      })
    }
    await act(async () => held.resolve(listing('target.txt')))
    await settle()
    expect(screen.getByDisplayValue('root draft')).toBe(input)
    expect(current().projection.hasPath(`${parent}/old.txt`)).toBe(true)
    expect(useAppStore.getState().pendingExplorerReveal?.filePath).toBe(`${parent}/target.txt`)
    expect(current().selected).not.toBe(parent)
    expect(scroll).not.toHaveBeenCalled()
    const before = read.mock.calls.length
    read.mockImplementation((_id, _root, path) =>
      Promise.resolve(scoped && path === '/repo' ? rootListing() : listing('target.txt'))
    )
    act(() => current().input.dismissInlineInput())
    await settle()
    expect(current().selected).toBe(`${parent}/target.txt`)
    expect(useAppStore.getState().pendingExplorerReveal).toBeNull()
    await deliverRevealScroll()
    expect(scroll).toHaveBeenCalledWith(
      current().projection.getIndexByPath(`${parent}/target.txt`),
      { align: 'center' }
    )
    expect(useAppStore.getState().pendingExplorerReveal).toBeNull()
    expect(current().pane.rowScrolling.flashingPath).toBeNull()
    expect(read.mock.calls.slice(before).every((call) => !call[3]?.wakeWslDistro)).toBe(true)
  }
)

it.each(['root', 'nested'] as const)(
  'same-commit Contents to actual manual reveal waits for disk-only %s target, without fallback',
  async (location) => {
    useAppStore.setState({ rightSidebarOpen: true, rightSidebarExplorerView: 'files' })
    const current = renderInteractionTree(owner, true)
    await settle()
    if (location === 'nested') {
      act(() => current().handlers.handleClick(current().rootCache!.children[0]))
      await settle()
    }
    const selectedBeforeReveal = current().selected
    expect(selectedBeforeReveal).toBe(location === 'nested' ? '/repo/a' : null)
    const readInputs = () =>
      read.mock.calls.map(([id, root, path, options]) => [id, root, path, options?.wakeWslDistro])
    expect(readInputs()).toEqual(
      location === 'nested'
        ? [
            ['wt', '/repo', '/repo', true],
            ['wt', '/repo', '/repo/a', true]
          ]
        : [['wt', '/repo', '/repo', true]]
    )
    const setupReads = read.mock.calls.length
    act(() => useAppStore.setState({ rightSidebarExplorerView: 'search' }))
    await settle()
    const root = gateRead(),
      ancestor = gateRead()
    const target = location === 'root' ? '/repo/target.txt' : '/repo/a/target.txt'
    read.mockImplementation((_id, _root, path) =>
      path === '/repo' ? root.promise : ancestor.promise
    )
    const scroll = vi.spyOn(current().pane.rowScrolling.virtualizer, 'scrollToIndex')
    act(() => useAppStore.getState().revealInExplorer('wt', target))
    expect(useAppStore.getState().rightSidebarExplorerView).toBe('files')
    expect(useAppStore.getState().pendingExplorerReveal?.filePath).toBe(target)
    const request = useAppStore.getState().pendingExplorerReveal
    expect(current().selected).toBe(selectedBeforeReveal)
    expect(current().pane.rowScrolling.flashingPath).toBeNull()
    expect(scroll).not.toHaveBeenCalled()
    await act(async () => root.resolve(location === 'root' ? listing('target.txt') : rootListing()))
    if (location === 'nested') {
      expect(useAppStore.getState().pendingExplorerReveal?.filePath).toBe(target)
      expect(current().selected).toBe(selectedBeforeReveal)
      expect(useAppStore.getState().pendingExplorerReveal).toBe(request)
      expect(current().pane.rowScrolling.flashingPath).toBeNull()
      expect(scroll).not.toHaveBeenCalled()
      await act(async () => ancestor.resolve(listing('target.txt')))
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(current().selected).toBe(target)
    expect(current().pane.rowScrolling.flashingPath).toBe(target)
    expect(scroll).toHaveBeenCalledWith(current().projection.getIndexByPath(target), {
      align: 'center'
    })
    expect(useAppStore.getState().pendingExplorerReveal).toBeNull()
    expect(readInputs().slice(setupReads)).toEqual(
      location === 'nested'
        ? [
            ['wt', '/repo', '/repo', undefined],
            ['wt', '/repo', '/repo/a', undefined]
          ]
        : [['wt', '/repo', '/repo', undefined]]
    )
  }
)

it.each(['projected', 'missing', 'ineligible', 'manual-quiet'] as const)(
  'new actual active input %s supersedes only automatic intent and fences all old callbacks',
  async (mode) => {
    read.mockResolvedValue(listing('old.txt', 'y.txt'))
    useAppStore.setState((state) => ({
      openFiles: [
        { ...state.openFiles[0], filePath: '/repo/t.txt' },
        {
          ...state.openFiles[0],
          id: 'y',
          filePath: mode === 'missing' ? '/repo/a/new-y.txt' : '/repo/y.txt',
          mode: mode === 'ineligible' ? 'diff' : 'edit'
        }
      ]
    }))
    const current = renderInteractionTree(owner)
    await settle()
    const root = gateRead()
    read.mockImplementation((_id, _root, path) =>
      path === '/repo' ? root.promise : Promise.resolve(listing('new-y.txt'))
    )
    act(() => {
      void current().refreshDir('/repo')
    })
    act(() => useAppStore.getState().setActiveFile('target', 'wt'))
    await act(async () => {
      await Promise.resolve()
    })
    if (mode === 'manual-quiet') {
      act(() => {
        useAppStore.getState().revealInExplorer('wt', '/repo/t.txt')
        useAppStore.setState((state) => ({
          pendingExplorerReveal: { ...state.pendingExplorerReveal!, flash: false }
        }))
      })
    }
    const scroll = vi.spyOn(current().pane.rowScrolling.virtualizer, 'scrollToIndex')
    // Resolve old T and activate Y in one act: Reveal is declared before AutoReveal in production.
    await act(async () => {
      root.resolve({
        ...listing('t.txt', 'y.txt'),
        entries: [
          ...listing('t.txt', 'y.txt').entries,
          { name: 'a', isDirectory: true, isSymlink: false }
        ]
      })
      await Promise.resolve()
      useAppStore.getState().setActiveFile('y', 'wt')
    })
    await settle()
    const expected =
      mode === 'manual-quiet'
        ? '/repo/t.txt'
        : mode === 'missing'
          ? '/repo/a/new-y.txt'
          : '/repo/y.txt'
    if (mode === 'ineligible') {
      expect(current().selected).not.toBe('/repo/t.txt')
      expect(current().selected).not.toBe('/repo/y.txt')
    } else {
      expect(current().selected).toBe(expected)
    }
    expect(useAppStore.getState().activeFileId).toBe('y')
    expect(useAppStore.getState().pendingExplorerReveal).toBeNull()
    if (mode !== 'manual-quiet') {
      const oldIndex = current().projection.getIndexByPath('/repo/t.txt')
      expect(scroll.mock.calls.some(([index]) => index === oldIndex)).toBe(false)
    }
    expect(current().pane.rowScrolling.flashingPath).toBeNull()
    const reads = read.mock.calls.length
    // Unchanged id/visibility is not a new producer.
    act(() => useAppStore.getState().setActiveFile('y', 'wt'))
    await settle()
    expect(read).toHaveBeenCalledTimes(reads)
  }
)

it('does not consume an older rendered projection when owner publication precedes passive reveal effects', async () => {
  read.mockResolvedValue(listing('target.txt'))
  const reset = vi.fn(),
    filter = vi.fn(),
    selections: (string | null)[] = []
  const hook = renderHook(() => {
    const current = useVisibleTree(visibleProps, reset, filter, owner)
    const request = useAppStore((state) => state.pendingExplorerReveal)
    const published = useRef(false)
    const { setDirCache, selected } = current
    useLayoutEffect(() => {
      if (!request || published.current) {
        return
      }
      published.current = true
      // The real owner's synchronous publication is ahead of this commit's projection.
      setDirCache({ '/repo': { children: [], operationOwner: owner } })
    }, [request, setDirCache])
    useLayoutEffect(() => {
      selections.push(selected)
    }, [selected])
    return current
  })
  await settle()
  act(() => useAppStore.getState().revealInExplorer('wt', '/repo/target.txt'))
  await settle()
  expect(selections).not.toContain('/repo/target.txt')
  expect(hook.result.current.projection.hasPath('/repo/target.txt')).toBe(false)
  expect(useAppStore.getState().pendingExplorerReveal).toBeNull()
  expect(read).toHaveBeenCalledTimes(1)
})

it.each(['frame', 'timeout'] as const)(
  'retires already scheduled automatic %s delivery after actual Y activation',
  async (phase) => {
    const frames: FrameRequestCallback[] = []
    const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    try {
      useAppStore.setState((state) => ({
        openFiles: [...state.openFiles, { ...state.openFiles[0], id: 'y', filePath: '/repo/y.txt' }]
      }))
      read.mockImplementation((_id, _root, path) =>
        Promise.resolve(
          path === '/repo'
            ? { ...rootListing(), entries: [...rootListing().entries, ...listing('y.txt').entries] }
            : listing('target.txt')
        )
      )
      const current = renderInteractionTree(owner)
      await act(async () => {
        await Promise.resolve()
      })
      act(() => useAppStore.getState().setActiveFile('target', 'wt'))
      await act(async () => {
        await Promise.resolve()
      })
      expect(current().selected).toBe('/repo/a/target.txt')
      const oldIndex = current().projection.getIndexByPath('/repo/a/target.txt')
      const scroll = vi.spyOn(current().pane.rowScrolling.virtualizer, 'scrollToIndex')
      if (phase === 'timeout') {
        frames.splice(0).forEach((callback) => callback(0))
      }
      act(() => useAppStore.getState().setActiveFile('y', 'wt'))
      frames.splice(0).forEach((callback) => callback(0))
      await settle()
      expect(current().selected).toBe('/repo/y.txt')
      expect(scroll.mock.calls.some(([index]) => index === oldIndex)).toBe(false)
      expect(useAppStore.getState().pendingExplorerReveal).toBeNull()
      expect(useAppStore.getState().activeFileId).toBe('y')
    } finally {
      frame.mockRestore()
    }
  }
)

it.each(['active-editor', 'pending-manual'] as const)(
  'expires rendered manual flash after newer %s intent while keeping current navigation',
  async (nextIntent) => {
    useAppStore.setState((state) => ({
      openFiles: [...state.openFiles, { ...state.openFiles[0], id: 'y', filePath: '/repo/y.txt' }]
    }))
    const heldB = gateRead()
    read.mockImplementation((_id, _root, path) =>
      Promise.resolve(
        path === '/repo'
          ? {
              ...listing('y.txt'),
              entries: [
                ...listing('y.txt').entries,
                ...['a', 'b'].map((name) => ({ name, isDirectory: true, isSymlink: false }))
              ]
            }
          : listing('old.txt')
      )
    )
    const current = renderInteractionTree(owner)
    await settle()
    const scroll = vi.spyOn(current().pane.rowScrolling.virtualizer, 'scrollToIndex')
    act(() => useAppStore.getState().revealInExplorer('wt', '/repo/a/old.txt'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(current().selected).toBe('/repo/a/old.txt')
    await deliverRevealScroll()
    expect(current().pane.rowScrolling.flashingPath).toBe('/repo/a/old.txt')
    expect(screen.getByText('old.txt').getAttribute('data-flashing')).toBe('true')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    if (nextIntent === 'active-editor') {
      act(() => useAppStore.getState().setActiveFile('y', 'wt'))
    } else {
      read.mockImplementation((_id, _root, path) =>
        path === '/repo/b' ? heldB.promise : Promise.resolve(listing('old.txt'))
      )
      act(() => useAppStore.getState().revealInExplorer('wt', '/repo/b/target.txt'))
    }
    const pendingB = useAppStore.getState().pendingExplorerReveal
    await deliverRevealScroll()
    scroll.mockClear()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100)
    })
    expect(current().pane.rowScrolling.flashingPath).toBeNull()
    expect(screen.getByText('old.txt').getAttribute('data-flashing')).toBe('false')
    expect(scroll).not.toHaveBeenCalled()
    if (nextIntent === 'active-editor') {
      expect(current().selected).toBe('/repo/y.txt')
      expect(useAppStore.getState().activeFileId).toBe('y')
      expect(useAppStore.getState().pendingExplorerReveal).toBeNull()
    } else {
      expect(current().selected).toBe('/repo/a/old.txt')
      expect(useAppStore.getState().pendingExplorerReveal).toBe(pendingB)
      await act(async () => heldB.resolve(listing('target.txt')))
      expect(current().selected).toBe('/repo/b/target.txt')
      await deliverRevealScroll()
      expect(scroll).toHaveBeenCalledWith(
        current().projection.getIndexByPath('/repo/b/target.txt'),
        { align: 'center' }
      )
      expect(current().pane.rowScrolling.flashingPath).toBe('/repo/b/target.txt')
      expect(useAppStore.getState().pendingExplorerReveal).toBeNull()
    }
  }
)

it.each(['same-path', 'different-path'] as const)(
  'replacement %s flash keeps its own two-second lifetime',
  async (replacement) => {
    read.mockResolvedValue(listing('a.txt', 'b.txt'))
    const current = renderInteractionTree(owner)
    await settle()
    act(() => useAppStore.getState().revealInExplorer('wt', '/repo/a.txt'))
    expect(current().pane.rowScrolling.flashingPath).toBe('/repo/a.txt')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    const target = replacement === 'same-path' ? '/repo/a.txt' : '/repo/b.txt'
    act(() => useAppStore.getState().revealInExplorer('wt', target))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100)
    })
    expect(current().pane.rowScrolling.flashingPath).toBe(target)
    expect(current().selected).toBe(target)
    expect(screen.getByText(target.slice(6)).getAttribute('data-flashing')).toBe('true')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(901)
    })
    expect(current().pane.rowScrolling.flashingPath).toBeNull()
    expect(screen.getByText(target.slice(6)).getAttribute('data-flashing')).toBe('false')
    expect(useAppStore.getState().pendingExplorerReveal).toBeNull()
  }
)
