// @vitest-environment happy-dom
import {
  lifetimeWork,
  readDirectoryMock,
  initialAppState,
  entry,
  listing
} from './file-explorer-refresh-projection-test-fixtures'
import { Fragment, type ReactNode } from 'react'
import type { FileExplorerDirLoadToken } from './file-explorer-dir-load-tracker'
import { act, cleanup, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  noteUserWorkspaceSwitch,
  resetWorkspaceSwitchUserActsForTests
} from '@/lib/workspace-switch-user-act'
import {
  gateRead,
  initializeExplorerSubscriptions,
  useVisibleTree,
  visibleProps
} from './file-explorer-lifecycle-test-support'
import { getVisibleFileExplorerWorktreePath } from './file-explorer-reset'

it.each([100, 1000])(
  'retires actual Pane single cohorts at %i across every owner boundary',
  async (count) => {
    for (const boundary of [
      'hide',
      'contents',
      'invalidate',
      'reset',
      'root-retry',
      'unmount',
      'owner-replacement',
      'direct-reset'
    ] as const) {
      useAppStore.setState(initialAppState, true)
      useAppStore.setState({
        activeWorktreeId: 'wt',
        rightSidebarOpen: true,
        rightSidebarExplorerView: 'files',
        expandedDirs: {}
      })
      initializeExplorerSubscriptions()
      lifetimeWork.measuring = false
      const paths = Array.from({ length: count }, (_, i) => `/repo/d${i}`),
        gates = paths.map(() => gateRead()),
        rootGate = gateRead()
      let rootReads = 0,
        ownerKey = 0
      readDirectoryMock
        .mockReset()
        .mockImplementation((_id, _root, path) =>
          path === '/repo'
            ? ++rootReads === 1
              ? Promise.resolve(listing(...paths.map((path) => entry(path.slice(6), true))))
              : rootGate.promise
            : gates[paths.indexOf(path)].promise
        )
      const registryMaps = new WeakSet<object>(),
        realSet = Map.prototype.set
      const setSpy = vi.spyOn(Map.prototype, 'set').mockImplementation(function (
        this: Map<unknown, unknown>,
        key,
        value
      ) {
        if (
          lifetimeWork.beginning &&
          typeof value === 'object' &&
          value !== null &&
          'dirPath' in value
        ) {
          registryMaps.add(this)
        }
        return realSet.call(this, key, value)
      })
      const add = vi.spyOn(AbortSignal.prototype, 'addEventListener'),
        remove = vi.spyOn(AbortSignal.prototype, 'removeEventListener')
      const hook = renderHook(
        () => {
          const open = useAppStore((state) => state.rightSidebarOpen),
            view = useAppStore((state) => state.rightSidebarExplorerView)
          return useVisibleTree(
            {
              ...visibleProps,
              visible:
                getVisibleFileExplorerWorktreePath({
                  rightSidebarOpen: open,
                  explorerView: view,
                  worktreePath: '/repo'
                }) !== null
            },
            reset,
            filter,
            { kind: 'local' }
          )
        },
        {
          wrapper: ({ children }: { children: ReactNode }) => (
            <Fragment key={ownerKey}>{children}</Fragment>
          )
        }
      )
      function reset() {}
      function filter() {}
      try {
        await act(async () => {
          await Promise.resolve()
          await Promise.resolve()
        })
        const owner = lifetimeWork.owners[0],
          tracker = owner.dirLoadTrackerRef.current,
          signal = owner.executionRef.current.signal
        act(() =>
          paths.forEach((path) =>
            hook.result.current.handlers.handleClick(
              hook.result.current.projection.getRowByPath(path)!
            )
          )
        )
        expect(readDirectoryMock).toHaveBeenCalledTimes(count + 1)
        expect(readDirectoryMock.mock.calls.slice(1).every((call) => call[3]?.wakeWslDistro)).toBe(
          true
        )
        const tokens = paths.map((path) => tracker.get(path)!),
          tokenSet = new Set(tokens),
          outcomes: string[] = []
        tokens.forEach((token) => {
          void tracker.observe(token).then((outcome) => outcomes.push(outcome))
        })
        expect(owner.loadingDirPathsRef.current.size).toBe(count)
        const resetCalls = vi.spyOn(tracker, 'reset')
        const admissionListeners = add.mock.calls.filter(
          ([type], i) => type === 'abort' && add.mock.contexts[i] === signal
        ).length
        act(() => hook.result.current.setDrag('/repo'))
        let registryVisits = 0,
          waveVisits = 0
        const originalValues = Map.prototype.values
        const values = vi.spyOn(Map.prototype, 'values').mockImplementation(function (
          this: Map<unknown, FileExplorerDirLoadToken>
        ) {
          const iterator = originalValues.call(this),
            next = iterator.next.bind(iterator)
          iterator.next = (...args) => {
            const result = next(...args)
            if (lifetimeWork.measuring && !result.done && tokenSet.has(result.value)) {
              if (registryMaps.has(this)) {
                registryVisits++
              } else {
                waveVisits++
              }
            }
            return result
          }
          return iterator
        })
        lifetimeWork.updates = []
        lifetimeWork.copiedMembers = lifetimeWork.allocations = lifetimeWork.clearPaths = 0
        lifetimeWork.measuring = true
        act(() => {
          if (boundary === 'hide') {
            useAppStore.setState({ rightSidebarOpen: false })
          }
          if (boundary === 'contents') {
            useAppStore.setState({ rightSidebarExplorerView: 'search' })
          }
          if (boundary === 'invalidate') {
            hook.result.current.invalidateTree()
          }
          if (boundary === 'reset') {
            hook.result.current.resetAndLoad()
          }
          if (boundary === 'root-retry') {
            void hook.result.current.refreshDir('/repo', { wakeWslDistro: true })
          }
          if (boundary === 'unmount') {
            hook.unmount()
          }
          if (boundary === 'owner-replacement') {
            ownerKey++
            hook.rerender()
          }
          if (boundary === 'direct-reset') {
            tracker.reset()
          }
        })
        await act(async () => {
          await Promise.resolve()
          await Promise.resolve()
        })
        const retired = lifetimeWork.updates.filter(
          (update) => update.owner === tracker && update.after <= update.before
        )
        expect({
          boundary,
          copiedMembers: lifetimeWork.copiedMembers,
          allocations: lifetimeWork.allocations
        }).toEqual({ boundary, copiedMembers: 0, allocations: 0 })
        expect(retired).toHaveLength(count + resetCalls.mock.calls.length)
        expect(retired.filter((update) => update.changed)).toHaveLength(1)
        expect(registryVisits).toBe(count)
        expect(waveVisits).toBe(0)
        expect(lifetimeWork.clearPaths).toBe(count)
        expect(outcomes).toHaveLength(count)
        expect(outcomes.every((outcome) => outcome === 'superseded')).toBe(true)
        expect(admissionListeners).toBe(0)
        expect(
          remove.mock.calls.filter(
            ([type], i) => type === 'abort' && remove.mock.contexts[i] === signal
          )
        ).toHaveLength(0)
        expect(signal.aborted).toBe(true)
        expect(readDirectoryMock.mock.calls.filter((call) => call[2] !== '/repo')).toHaveLength(
          count
        )
        lifetimeWork.measuring = false
        values.mockRestore()
        if (boundary === 'direct-reset') {
          lifetimeWork.updates = []
          lifetimeWork.measuring = true
          act(() => tracker.reset())
          expect(lifetimeWork.updates).toEqual([
            { owner: tracker, before: 0, after: 0, changed: false }
          ])
          lifetimeWork.measuring = false
          const successor = gateRead()
          readDirectoryMock.mockImplementation((_id, _root, path) =>
            path === paths[0] ? successor.promise : new Promise(() => {})
          )
          act(() => {
            hook.result.current.handlers.handleClick(
              hook.result.current.projection.getRowByPath(paths[0])!
            )
            hook.result.current.handlers.handleClick(
              hook.result.current.projection.getRowByPath(paths[0])!
            )
          })
          const current = tracker.get(paths[0])!
          expect(current).toBeDefined()
          expect(current).not.toBe(tokens[0])
          const cache = owner.dirCacheRef.current
          await act(async () =>
            gates.forEach((gate, index) =>
              index % 2
                ? gate.reject(new Error('late old error'))
                : gate.resolve(listing(entry('late-old')))
            )
          )
          expect(owner.dirCacheRef.current).toBe(cache)
          expect(tracker.get(paths[0])).toBe(current)
          expect(owner.loadingDirPathsRef.current.has(paths[0])).toBe(true)
          await act(async () => successor.resolve(listing(entry('current'))))
          expect(await current.promise).toBe('refreshed')
          expect(owner.dirCacheRef.current[paths[0]].children[0].name).toBe('current')
        }
      } finally {
        lifetimeWork.measuring = false
        hook.unmount()
        setSpy.mockRestore()
        add.mockRestore()
        remove.mockRestore()
        await act(async () => {
          gates.forEach((gate) => gate.resolve(listing()))
          rootGate.resolve(listing())
        })
        cleanup()
        vi.unstubAllGlobals()
      }
    }
  }
)

it.each([100, 1000])(
  'retires actual mixed single/two-Wave populations at %i, including publication failure',
  async (count) => {
    for (const failPublication of [false, true]) {
      useAppStore.setState(initialAppState, true)
      useAppStore.setState({
        activeWorktreeId: 'wt',
        rightSidebarOpen: true,
        rightSidebarExplorerView: 'files',
        expandedDirs: {}
      })
      initializeExplorerSubscriptions()
      const singles = Array.from({ length: count }, (_, i) => `/repo/s${i}`),
        waves = [0, 1].map((group) => Array.from({ length: 32 }, (_, i) => `/repo/w${group}-${i}`)),
        paths = [...singles, ...waves.flat()]
      const gates = new Map(paths.map((path) => [path, gateRead()])),
        admitted = new Map<string, { gate: ReturnType<typeof gateRead>; call: number }>()
      readDirectoryMock.mockReset().mockImplementation((_id, _root, path) => {
        if (path === '/repo') {
          return Promise.resolve(listing(...paths.map((path) => entry(path.slice(6), true))))
        }
        const gate = gates.get(path)!
        admitted.set(path, { gate, call: readDirectoryMock.mock.calls.length })
        return gate.promise
      })
      const add = vi.spyOn(AbortSignal.prototype, 'addEventListener'),
        remove = vi.spyOn(AbortSignal.prototype, 'removeEventListener'),
        reset = vi.fn(),
        filter = vi.fn()
      resetWorkspaceSwitchUserActsForTests()
      noteUserWorkspaceSwitch('wt')
      const hook = renderHook(() => useVisibleTree(visibleProps, reset, filter, { kind: 'local' }))
      try {
        await act(async () => {
          await Promise.resolve()
          await Promise.resolve()
        })
        const owner = lifetimeWork.owners[0],
          tracker = owner.dirLoadTrackerRef.current,
          signal = owner.executionRef.current.signal
        act(() =>
          singles.forEach((path) =>
            hook.result.current.handlers.handleClick(
              hook.result.current.projection.getRowByPath(path)!
            )
          )
        )
        // The actual demand consumer admits two disjoint Waves; each retains queued/started records.
        act(() =>
          waves.forEach((paths) =>
            hook.result.current.reconcileView(new Set(paths), () => true, null)
          )
        )
        const obsoleteQueued = tracker.get(waves[0][31])!
        act(() =>
          hook.result.current.handlers.handleClick(
            hook.result.current.projection.getRowByPath(waves[0][31])!
          )
        )
        expect(await obsoleteQueued.promise).toBe('superseded')
        await act(async () =>
          waves.forEach((paths) => gates.get(paths[0])!.resolve(listing(entry('ready'))))
        )
        const oldCalls = readDirectoryMock.mock.calls.slice(),
          oldPaths = [
            '/repo',
            ...singles,
            ...waves.flatMap((paths) => paths.slice(0, 17)),
            waves[0][31]
          ],
          neverAdmitted = [...waves[0].slice(17, 31), ...waves[1].slice(17)]
        expect(oldCalls).toHaveLength(count + 36)
        expect(oldCalls.map((call) => call[2]).sort()).toEqual([...oldPaths].sort())
        expect(admitted.size).toBe(count + 35)
        expect(paths.filter((path) => !admitted.has(path))).toEqual(neverAdmitted)
        expect(neverAdmitted).toHaveLength(29)
        for (const [path, { gate, call }] of admitted) {
          expect(gate).toBe(gates.get(path))
          expect(oldCalls[call - 1][2]).toBe(path)
        }
        expect(
          oldCalls.every((call) =>
            call[2] === '/repo' || singles.includes(call[2]) || call[2] === waves[0][31]
              ? call[3]?.wakeWslDistro === true
              : call[3]?.wakeWslDistro !== true
          )
        ).toBe(true)
        const expectNoQueuedDispatch = () => {
          expect(readDirectoryMock.mock.calls.map((call) => call[2]).sort()).toEqual(
            [...oldPaths, singles[0]].sort()
          )
          expect(readDirectoryMock).toHaveBeenCalledTimes(count + 37)
          expect(readDirectoryMock.mock.calls.some((call) => neverAdmitted.includes(call[2]))).toBe(
            false
          )
          expect(readDirectoryMock.mock.calls.slice(0, oldCalls.length)).toEqual(oldCalls)
        }
        act(() => hook.result.current.setDrag('/repo'))
        const tokens = paths.map((path) => tracker.get(path)!),
          tokenSet = new Set(tokens),
          outcomes: string[] = []
        tokens.forEach((token) => {
          void token.promise.then((outcome) => outcomes.push(outcome))
        })
        const realValues = Map.prototype.values
        let scans = 0,
          population = 0
        const values = vi.spyOn(Map.prototype, 'values').mockImplementation(function (
          this: Map<unknown, FileExplorerDirLoadToken>
        ) {
          const iterator = realValues.call(this),
            next = iterator.next.bind(iterator)
          let visited = false
          iterator.next = (...args) => {
            const result = next(...args)
            if (
              lifetimeWork.measuring &&
              !result.done &&
              (tokenSet.has(result.value) || result.value === obsoleteQueued)
            ) {
              if (!visited) {
                scans++
                visited = true
              }
              population++
            }
            return result
          }
          return iterator
        })
        lifetimeWork.updates = []
        lifetimeWork.copiedMembers = lifetimeWork.allocations = 0
        lifetimeWork.measuring = true
        const failure = new Error('publication reported failure')
        if (failPublication) {
          const actualUpdate = vi.mocked(owner.updateLoadingDirPaths).getMockImplementation()!
          vi.mocked(owner.updateLoadingDirPaths).mockImplementationOnce((update) => {
            actualUpdate(update)
            throw failure
          })
        }
        act(() => {
          if (failPublication) {
            expect(() => tracker.reset()).toThrow(failure)
          } else {
            tracker.reset()
          }
        })
        await act(async () => {
          await Promise.resolve()
          await Promise.resolve()
        })
        expect(signal.aborted).toBe(true)
        expect(outcomes).toHaveLength(count + 64)
        expect(outcomes.every((outcome) => outcome === 'superseded')).toBe(true)
        expect(lifetimeWork.copiedMembers).toBe(0)
        expect(lifetimeWork.allocations).toBe(0)
        expect(lifetimeWork.updates).toHaveLength(1 + count + 64 + 2 * 2)
        expect(lifetimeWork.updates.filter((update) => update.changed)).toHaveLength(1)
        // Two retained32-path inventories, including one replaced token, run at abort and finally; remaining registry is S+1.
        expect(scans).toBe(5)
        expect(population).toBe(2 * (32 + 32) + count + 1)
        const registrations = add.mock.calls.filter(
          ([type], i) => type === 'abort' && add.mock.contexts[i] === signal
        )
        const removals = () =>
          remove.mock.calls.filter(
            ([type], i) => type === 'abort' && remove.mock.contexts[i] === signal
          )
        expect(registrations).toHaveLength(2)
        expect(registrations[0][1]).not.toBe(registrations[1][1])
        for (const [, listener, options] of registrations) {
          expect(options).toEqual({ once: true })
          const matching = removals().filter(([, removed]) => removed === listener)
          // DOM once-dispatch may remove before the Wave's explicit finally cleanup.
          expect(matching.length).toBeGreaterThanOrEqual(1)
          expect(matching.length).toBeLessThanOrEqual(2)
          expect(
            matching.every(([, , capture]) =>
              typeof capture === 'boolean' ? !capture : !capture?.capture
            )
          ).toBe(true)
        }
        expect(
          removals().every(([, listener]) => registrations.some(([, added]) => added === listener))
        ).toBe(true)
        const removalCalls = removals().length
        lifetimeWork.measuring = false
        values.mockRestore()
        expect(owner.loadingDirPathsRef.current.size).toBe(0)
        const successorGate = gateRead()
        readDirectoryMock.mockImplementation((_id, _root, path) =>
          path === singles[0] ? successorGate.promise : new Promise(() => {})
        )
        act(() => {
          hook.result.current.handlers.handleClick(
            hook.result.current.projection.getRowByPath(singles[0])!
          )
          hook.result.current.handlers.handleClick(
            hook.result.current.projection.getRowByPath(singles[0])!
          )
        })
        const successor = tracker.get(singles[0])!,
          cache = owner.dirCacheRef.current,
          oldSuccesses: string[] = [],
          oldErrors: string[] = []
        expectNoQueuedDispatch()
        await act(async () => {
          paths.forEach((path, i) => {
            const returned = admitted.get(path)
            if (!returned) {
              gates.get(path)!.resolve(listing())
            } else if (i % 2) {
              oldErrors.push(path)
              returned.gate.reject(
                new Error(`late error: ${path}, old provider call ${returned.call}`)
              )
            } else {
              oldSuccesses.push(path)
              returned.gate.resolve(listing(entry('old')))
            }
          })
        })
        expect(oldErrors).toHaveLength(count / 2 + 17)
        expect(oldSuccesses).toHaveLength(count / 2 + 18)
        for (const cohort of [singles, ...waves]) {
          expect(oldErrors).toContain(cohort[1])
          expect(oldSuccesses).toContain(cohort[2])
        }
        expect(oldErrors).toContain(waves[0][31])
        expectNoQueuedDispatch()
        expect(owner.dirCacheRef.current).toBe(cache)
        expect(tracker.get(singles[0])).toBe(successor)
        expect(owner.loadingDirPathsRef.current.has(singles[0])).toBe(true)
        await act(async () => successorGate.resolve(listing(entry('new'))))
        expect(await successor.promise).toBe('refreshed')
        expect(owner.dirCacheRef.current[singles[0]].children[0].name).toBe('new')
        expectNoQueuedDispatch()
        expect(removals()).toHaveLength(removalCalls)
      } finally {
        lifetimeWork.measuring = false
        hook.unmount()
        add.mockRestore()
        remove.mockRestore()
        await act(async () => gates.forEach((gate) => gate.resolve(listing())))
        cleanup()
        vi.unstubAllGlobals()
      }
    }
  }
)
