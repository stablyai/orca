// @vitest-environment happy-dom
import {
  initialAppState,
  lifetimeWork,
  readDirectoryMock
} from './file-explorer-refresh-projection-test-fixtures'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  useVisibleTree,
  visibleProps,
  initializeExplorerSubscriptions
} from './file-explorer-lifecycle-test-support'
import { applyFileExplorerNavigation } from './file-explorer-keyboard-navigation'
import { emptyReadError, flushWorkers } from './file-explorer-expanded-refresh-test-support'
import { PATH_OUTSIDE_ALLOWED_DIRECTORIES } from '../../../../shared/local-file-access'
import type { DirEntry } from '../../../../shared/filesystem-entry-types'
import type * as RuntimeFiles from '@/runtime/runtime-file-mutation-client'
import type * as DirectoryListing from './file-explorer-directory-listing'
import { fileExplorerNodeTabRelativePath } from './file-explorer-directory-listing'

const transport = vi.hoisted(() => vi.fn<typeof RuntimeFiles.readRuntimeDirectory>())
vi.mock('@/runtime/runtime-file-mutation-client', async (original) => ({
  ...(await original<typeof RuntimeFiles>()),
  readRuntimeDirectory: transport
}))
const owner = { kind: 'local' } as const
const directory: DirEntry = { name: 'folder', isDirectory: true, isSymlink: false }
const file = (name: string): DirEntry => ({ name, isDirectory: false, isSymlink: false })
function gateEntries() {
  let resolve!: (entries: DirEntry[]) => void, reject!: (error: Error) => void
  const promise = new Promise<DirEntry[]>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function mount() {
  const reset = vi.fn(),
    filter = vi.fn()
  return renderHook((props) => useVisibleTree(props, reset, filter, owner), {
    initialProps: visibleProps
  })
}
const path = '/repo/folder'
const outside = () => new Error(PATH_OUTSIDE_ALLOWED_DIRECTORIES)
const actual = await vi.importActual<typeof DirectoryListing>('./file-explorer-directory-listing')
beforeEach(() => {
  useAppStore.setState(initialAppState, true)
  initializeExplorerSubscriptions()
  transport.mockReset()
  readDirectoryMock.mockReset().mockImplementation(actual.readFileExplorerDirectory)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
type Gesture = 'mouse' | 'keyboard' | 'internal-hover' | 'native-hover' | 'file' | 'folder'
function request(current: ReturnType<typeof useVisibleTree>, gesture: Gesture) {
  const node = current.projection.getRowByPath(path)!
  if (gesture === 'mouse') {
    current.handlers.handleClick(node)
  } else if (gesture === 'keyboard') {
    applyFileExplorerNavigation(
      {
        rowProjection: current.projection,
        activeWorktreeId: 'wt',
        selectedNode: node,
        isExpanded: (value) => current.expanded.has(value),
        findFocusedIndex: () => null,
        handlers: {
          toggleDir: current.toggleDir,
          moveSelection: vi.fn(),
          scrollToIndex: vi.fn(),
          focusRowAtIndex: vi.fn()
        }
      },
      new KeyboardEvent('keydown', { key: 'ArrowRight' })
    )
  } else if (gesture === 'internal-hover') {
    current.hover.handleDragExpandDir(path)
  } else if (gesture === 'native-hover') {
    current.hover.handleNativeDragExpandDir(path)
  } else {
    current.input.startNew(gesture, path, 1)
  }
}

it.each(['mouse', 'keyboard', 'internal-hover', 'native-hover', 'file', 'folder'] as const)(
  'a real %s request reaches the SAME path after its passive attempt has fully terminated',
  async (gesture) => {
    for (const scenario of ['empty-error', 'outside-refusal', 'old-success-error'] as const) {
      useAppStore.setState(initialAppState, true)
      const passive = gateEntries(),
        genuine = gateEntries()
      let phase: 'initial' | 'passive' | 'genuine' = 'initial'
      transport.mockReset().mockImplementation(async (_context, requested, options) => {
        if (requested === '/repo') {
          return [directory]
        }
        if (phase === 'initial') {
          return [file('old.txt')]
        }
        if (phase === 'passive') {
          return passive.promise
        }
        if (!options?.access) {
          throw outside()
        }
        return genuine.promise
      })
      const hook = mount()
      await act(flushWorkers)
      if (scenario === 'old-success-error') {
        act(() =>
          hook.result.current.handlers.handleClick(hook.result.current.rootCache!.children[0])
        )
        await act(flushWorkers)
        expect(hook.result.current.dirCache[path].children[0].name).toBe('old.txt')
        phase = 'passive'
        hook.rerender({ ...visibleProps, visible: false })
        hook.rerender(visibleProps)
      } else {
        phase = 'passive'
        act(() => useAppStore.setState({ expandedDirs: { wt: new Set([path]) } }))
      }
      await act(flushWorkers)
      const tracker = lifetimeWork.owners[0].dirLoadTrackerRef.current
      const passiveToken = tracker.get(path)!
      expect(passiveToken.started).toBe(true)
      const error = scenario === 'empty-error' ? emptyReadError() : outside()
      await act(async () => {
        passive.reject(error)
        await passiveToken.promise
        await flushWorkers()
      })
      expect(hook.result.current.dirCache[path].error).toBe(error.message)
      expect(hook.result.current.dirCache[path].children.map((child) => child.name)).toEqual(
        scenario === 'old-success-error' ? ['old.txt'] : []
      )
      expect(hook.result.current.loadingDirPaths.has(path)).toBe(false)
      expect(hook.result.current.isDirStale(path)).toBe(false)
      expect(tracker.get(path)).toBeUndefined()
      expect(await passiveToken.promise).toBe('root-unreadable')
      const terminalReads = transport.mock.calls.length
      hook.rerender(visibleProps)
      await act(flushWorkers)
      expect(transport).toHaveBeenCalledTimes(terminalReads)
      // New requests its already-expanded parent once; opening producers must actually open it.
      if (gesture !== 'file' && gesture !== 'folder') {
        act(() =>
          hook.result.current.handlers.handleClick(hook.result.current.rootCache!.children[0])
        )
      }
      phase = 'genuine'
      if (gesture === 'native-hover') {
        act(() => hook.result.current.setNative(true))
        expect(hook.result.current.native).toBe(true)
      } else if (gesture === 'internal-hover') {
        act(() => hook.result.current.setDrag('/repo/drag-source.txt'))
      }
      act(() => request(hook.result.current, gesture))
      await act(flushWorkers)
      // Old-source meaningful red: no forced wake-enabled read starts after the terminal failure.
      expect(
        transport.mock.calls
          .slice(terminalReads)
          .map((call) => [call[1], call[2]?.wakeWslDistro, call[2]?.access?.kind])
      ).toEqual([
        [path, true, undefined],
        [path, true, 'project-folder-link']
      ])
      const current = tracker.get(path)!
      expect(current).not.toBe(passiveToken)
      expect(current.revision).toBeGreaterThan(passiveToken.revision)
      expect(hook.result.current.loadingDirPaths.has(path)).toBe(true)
      const entries = scenario === 'empty-error' ? [] : [file('outside.txt')]
      await act(async () => {
        genuine.resolve(entries)
        await current.promise
        await flushWorkers()
      })
      expect(await current.promise).toBe('refreshed')
      expect(hook.result.current.dirCache[path].error).toBeUndefined()
      expect(hook.result.current.dirCache[path].outsideProject).toBe(true)
      expect(hook.result.current.dirCache[path].children.map((child) => child.name)).toEqual(
        entries.map((child) => child.name)
      )
      if (entries.length) {
        const child = hook.result.current.dirCache[path].children[0]
        expect(child.outsideProject).toBe(true)
        expect(fileExplorerNodeTabRelativePath(child)).toBe(`${path}/outside.txt`)
      }
      act(() => {
        hook.result.current.setNative(false)
        hook.result.current.setDrag(null)
        hook.result.current.input.dismissInlineInput()
      })
      const afterSuccess = transport.mock.calls.length
      act(() =>
        hook.result.current.handlers.handleClick(hook.result.current.rootCache!.children[0])
      )
      act(() =>
        hook.result.current.handlers.handleClick(hook.result.current.rootCache!.children[0])
      )
      await act(flushWorkers)
      expect(transport).toHaveBeenCalledTimes(afterSuccess)
      expect(hook.result.current.loadingDirPaths.size).toBe(0)
      expect(hook.result.current.isDirStale(path)).toBe(false)
      expect(tracker.get(path)).toBeUndefined()
      hook.unmount()
    }
  }
)

it.each(['EPERM', 'outside-again'] as const)(
  'a failed genuine reattempt terminates with correct %s provenance and allows the next input',
  async (failure) => {
    let phase: 'passive' | 'retry' | 'recovered' = 'passive'
    const contained = outside(),
      fallback = failure === 'EPERM' ? new Error('EPERM: folder unavailable') : outside()
    transport.mockImplementation(async (_context, requested, options) => {
      if (requested === '/repo') {
        return [directory]
      }
      if (phase === 'passive' || !options?.access) {
        throw contained
      }
      if (phase === 'retry') {
        throw fallback
      }
      return [file('recovered.txt')]
    })
    const hook = mount()
    await act(flushWorkers)
    act(() => useAppStore.setState({ expandedDirs: { wt: new Set([path]) } }))
    await act(flushWorkers)
    expect(hook.result.current.dirCache[path].error).toBe(contained.message)
    phase = 'retry'
    act(() => hook.result.current.handlers.handleClick(hook.result.current.rootCache!.children[0]))
    act(() => hook.result.current.handlers.handleClick(hook.result.current.rootCache!.children[0]))
    await act(flushWorkers)
    expect(hook.result.current.dirCache[path].error).toBe(
      failure === 'EPERM' ? fallback.message : contained.message
    )
    expect(
      transport.mock.calls.filter((call) => call[2]?.access?.kind === 'project-folder-link')
    ).toHaveLength(1)
    const settledReads = transport.mock.calls.length
    hook.rerender(visibleProps)
    await act(flushWorkers)
    expect(transport).toHaveBeenCalledTimes(settledReads)
    expect(hook.result.current.loadingDirPaths.size).toBe(0)
    phase = 'recovered'
    act(() => hook.result.current.handlers.handleClick(hook.result.current.rootCache!.children[0]))
    act(() => hook.result.current.handlers.handleClick(hook.result.current.rootCache!.children[0]))
    await act(flushWorkers)
    expect(hook.result.current.dirCache[path].children[0].name).toBe('recovered.txt')
    expect(hook.result.current.dirCache[path].error).toBeUndefined()
    expect(
      transport.mock.calls.slice(settledReads).every((call) => call[2]?.wakeWslDistro === true)
    ).toBe(true)
    expect(hook.result.current.loadingDirPaths.size).toBe(0)
  }
)
