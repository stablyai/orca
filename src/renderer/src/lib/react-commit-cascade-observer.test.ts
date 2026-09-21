import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  REACT_COMMIT_CASCADE_BREADCRUMB,
  REACT_COMMIT_CASCADE_NOTICE_LIMIT,
  resetReactCommitCascadeTelemetryForTests
} from './react-commit-cascade-telemetry'
import {
  REACT_COMMIT_CASCADE_INSTALL_CHECK_MS,
  REACT_COMMIT_CASCADE_UNINSTALLED_BREADCRUMB,
  installReactCommitCascadeObserver,
  resetReactCommitCascadeObserverForTests
} from './react-commit-cascade-observer'
import {
  ensureReactDevtoolsCommitHook,
  type ReactDevtoolsCommitHook
} from './react-devtools-commit-hook-shim'

const recordBreadcrumb = vi.fn()
vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: (name: string, data?: unknown) => recordBreadcrumb(name, data)
}))

const CASCADING_ROOT = { pendingLanes: 2 }

function readHook(): ReactDevtoolsCommitHook {
  return (globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: ReactDevtoolsCommitHook })
    .__REACT_DEVTOOLS_GLOBAL_HOOK__ as ReactDevtoolsCommitHook
}

beforeEach(() => {
  recordBreadcrumb.mockClear()
  resetReactCommitCascadeTelemetryForTests()
  resetReactCommitCascadeObserverForTests()
  // Why the delete: install wraps whatever is there, so a hook left over from
  // the previous test would stack a second counter onto the same callback.
  delete (globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__
  installReactCommitCascadeObserver()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('react devtools commit hook shim', () => {
  // Why asserted: without a pre-existing hook react-dom injects nothing, so a
  // packaged build only gets commit callbacks if the shim installs its own.
  it('exposes what react-dom requires to inject', () => {
    const hook = readHook()

    expect(hook.supportsFiber).toBe(true)
    expect(hook.isDisabled).toBe(false)
    expect(hook.inject?.({})).toBeGreaterThan(0)
    expect(typeof hook.onCommitFiberRoot).toBe('function')
  })

  // Why asserted: react-dom calls this once per DELETED FIBER, guarded only by
  // a typeof check. Defining it would put our shim on every unmount path.
  it('leaves the per-deleted-fiber callbacks undefined', () => {
    const hook = readHook() as Record<string, unknown>

    expect(hook.onCommitFiberUnmount).toBeUndefined()
    expect(hook.onPostCommitFiberRoot).toBeUndefined()
    expect(hook.setStrictMode).toBeUndefined()
  })

  // Why asserted: react-refresh captures this property and calls
  // oldOnCommitFiberRoot.apply(this, arguments) with no typeof guard, unlike the
  // fallback it gives onScheduleFiberRoot.
  it('ships a callable onCommitFiberRoot before anything wraps it', () => {
    delete (globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown })
      .__REACT_DEVTOOLS_GLOBAL_HOOK__
    const hook = ensureReactDevtoolsCommitHook()

    expect(typeof hook?.onCommitFiberRoot).toBe('function')
    expect(() => hook?.onCommitFiberRoot?.(1, null, undefined, false)).not.toThrow()
  })
})

describe('installReactCommitCascadeObserver', () => {
  it('breadcrumbs once the commit callback reaches the notice limit', () => {
    const hook = readHook()
    for (let commit = 0; commit < REACT_COMMIT_CASCADE_NOTICE_LIMIT; commit += 1) {
      hook.onCommitFiberRoot?.(1, CASCADING_ROOT, undefined, false)
    }

    expect(recordBreadcrumb).toHaveBeenCalledTimes(1)
    expect(recordBreadcrumb.mock.calls[0]?.[0]).toBe(REACT_COMMIT_CASCADE_BREADCRUMB)
  })

  it('ignores a commit whose root reports no cascading lanes', () => {
    const hook = readHook()
    for (let commit = 0; commit < REACT_COMMIT_CASCADE_NOTICE_LIMIT * 2; commit += 1) {
      hook.onCommitFiberRoot?.(1, { pendingLanes: 0 }, undefined, false)
    }

    expect(recordBreadcrumb).not.toHaveBeenCalled()
  })

  // Why asserted: a future React that stops exposing pendingLanes must make the
  // diagnostic go quiet, not fire on a depth it can no longer evaluate.
  it('ends the cascade when pendingLanes is not readable', () => {
    const hook = readHook()
    for (let commit = 0; commit < REACT_COMMIT_CASCADE_NOTICE_LIMIT - 1; commit += 1) {
      hook.onCommitFiberRoot?.(1, CASCADING_ROOT, undefined, false)
    }

    hook.onCommitFiberRoot?.(1, { renamedLanes: 2 }, undefined, false)
    for (let commit = 0; commit < REACT_COMMIT_CASCADE_NOTICE_LIMIT - 1; commit += 1) {
      hook.onCommitFiberRoot?.(1, CASCADING_ROOT, undefined, false)
    }

    expect(recordBreadcrumb).not.toHaveBeenCalled()
  })

  // Why a string and not undefined: '2' & 42 is 2, so a bitmask-only guard would
  // keep the cascade alive on a value React never meant as a lane.
  it('ends the cascade when pendingLanes is not a number', () => {
    const hook = readHook()
    for (let commit = 0; commit < REACT_COMMIT_CASCADE_NOTICE_LIMIT - 1; commit += 1) {
      hook.onCommitFiberRoot?.(1, CASCADING_ROOT, undefined, false)
    }

    hook.onCommitFiberRoot?.(1, { pendingLanes: '2' }, undefined, false)
    for (let commit = 0; commit < REACT_COMMIT_CASCADE_NOTICE_LIMIT - 1; commit += 1) {
      hook.onCommitFiberRoot?.(1, CASCADING_ROOT, undefined, false)
    }

    expect(recordBreadcrumb).not.toHaveBeenCalled()
  })

  it('chains onto an existing callback instead of replacing it', () => {
    const previous = vi.fn()
    const hook = readHook()
    hook.onCommitFiberRoot = previous
    resetReactCommitCascadeObserverForTests()
    installReactCommitCascadeObserver()

    hook.onCommitFiberRoot?.(7, CASCADING_ROOT, undefined, true)

    expect(previous).toHaveBeenCalledWith(7, CASCADING_ROOT, undefined, true)
  })

  // Why asserted: our throw would otherwise land in react-dom's own catch and
  // silently unhook DevTools and Fast Refresh from the rest of the chain.
  it('still calls the chained hook when our own work throws', () => {
    const previous = vi.fn()
    const hook = readHook()
    hook.onCommitFiberRoot = previous
    resetReactCommitCascadeObserverForTests()
    installReactCommitCascadeObserver()

    const hostile = {
      get pendingLanes(): number {
        throw new Error('hostile root')
      }
    }
    expect(() => hook.onCommitFiberRoot?.(1, hostile, undefined, false)).not.toThrow()
    expect(previous).toHaveBeenCalledTimes(1)
  })

  it('is idempotent, so a second install cannot double-count commits', () => {
    installReactCommitCascadeObserver()
    const hook = readHook()
    for (let commit = 0; commit < REACT_COMMIT_CASCADE_NOTICE_LIMIT - 1; commit += 1) {
      hook.onCommitFiberRoot?.(1, CASCADING_ROOT, undefined, false)
    }

    expect(recordBreadcrumb).not.toHaveBeenCalled()
  })
})

// Why: a reshuffled import or a bundler hoist disables the diagnostic with no
// test failure. This is what makes that visible in the field instead.
describe('install self-check', () => {
  it('breadcrumbs when no commit ever reached the hook', () => {
    vi.useFakeTimers()
    resetReactCommitCascadeObserverForTests()
    installReactCommitCascadeObserver()

    vi.advanceTimersByTime(REACT_COMMIT_CASCADE_INSTALL_CHECK_MS)

    expect(recordBreadcrumb).toHaveBeenCalledWith(
      REACT_COMMIT_CASCADE_UNINSTALLED_BREADCRUMB,
      undefined
    )
  })

  it('stays silent once any commit has been seen', () => {
    vi.useFakeTimers()
    resetReactCommitCascadeObserverForTests()
    installReactCommitCascadeObserver()
    readHook().onCommitFiberRoot?.(1, { pendingLanes: 0 }, undefined, false)

    vi.advanceTimersByTime(REACT_COMMIT_CASCADE_INSTALL_CHECK_MS)

    expect(recordBreadcrumb).not.toHaveBeenCalled()
  })

  // Why asserted: a hook that refuses the assignment is exactly the case the
  // self-check exists for, so it must arm on the failure path too.
  it('breadcrumbs when the hook refuses the callback assignment', () => {
    vi.useFakeTimers()
    resetReactCommitCascadeObserverForTests()
    const frozenHook = Object.freeze({ isDisabled: false, supportsFiber: true })
    ;(globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ =
      frozenHook

    expect(() => installReactCommitCascadeObserver()).not.toThrow()
    vi.advanceTimersByTime(REACT_COMMIT_CASCADE_INSTALL_CHECK_MS)

    expect((frozenHook as { onCommitFiberRoot?: unknown }).onCommitFiberRoot).toBeUndefined()
    expect(recordBreadcrumb).toHaveBeenCalledWith(
      REACT_COMMIT_CASCADE_UNINSTALLED_BREADCRUMB,
      undefined
    )
  })

  it('breadcrumbs when no hook can be reached at all', () => {
    vi.useFakeTimers()
    resetReactCommitCascadeObserverForTests()
    Object.defineProperty(globalThis, '__REACT_DEVTOOLS_GLOBAL_HOOK__', {
      configurable: true,
      get() {
        throw new Error('no devtools global')
      }
    })

    expect(() => installReactCommitCascadeObserver()).not.toThrow()
    vi.advanceTimersByTime(REACT_COMMIT_CASCADE_INSTALL_CHECK_MS)

    expect(recordBreadcrumb).toHaveBeenCalledWith(
      REACT_COMMIT_CASCADE_UNINSTALLED_BREADCRUMB,
      undefined
    )
  })
})

/**
 * Why an allocation assertion and not a timing one: this callback runs on every
 * commit the app makes, so the cost that matters is garbage. Measured on this
 * loop, an escaping object literal, a template string and a per-call closure
 * each cost more than 3.8 MB where the current code costs tens of KB.
 */
describe('commit hook cost', () => {
  const HOT_COMMITS = 1_000_000
  /** ~30x the measured zero-allocation baseline, ~4x under the cheapest regression. */
  const MAX_HEAP_GROWTH_BYTES = 1_000_000

  function measureHeapGrowth(commit: () => void): number {
    const collectGarbage = (globalThis as { gc?: () => void }).gc
    // --expose-gc is pinned in config/vitest.config.ts execArgv.
    expect(typeof collectGarbage).toBe('function')
    for (let warmup = 0; warmup < 50_000; warmup += 1) {
      commit()
    }
    collectGarbage?.()
    const before = process.memoryUsage().heapUsed
    for (let iteration = 0; iteration < HOT_COMMITS; iteration += 1) {
      commit()
    }
    return process.memoryUsage().heapUsed - before
  }

  it('allocates nothing on an ordinary commit', () => {
    const hook = readHook()
    const quietRoot = { pendingLanes: 0 }

    const growth = measureHeapGrowth(() => hook.onCommitFiberRoot?.(1, quietRoot, undefined, false))

    expect(growth).toBeLessThan(MAX_HEAP_GROWTH_BYTES)
  })

  // Why separately: the cascading branch runs the counter, the arm check and the
  // report guard, none of which may start allocating once a cascade is deep.
  it('allocates nothing while a cascade is being counted', () => {
    const hook = readHook()

    const growth = measureHeapGrowth(() =>
      hook.onCommitFiberRoot?.(1, CASCADING_ROOT, undefined, false)
    )

    expect(growth).toBeLessThan(MAX_HEAP_GROWTH_BYTES)
  })
})

// Why asserted: main.tsx imports this module for its side effect alone, so
// deleting the bare install call would disable the diagnostic in production.
describe('module self-install', () => {
  it('counts commits after nothing but an import', async () => {
    vi.useFakeTimers()
    delete (globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown })
      .__REACT_DEVTOOLS_GLOBAL_HOOK__
    vi.resetModules()

    await import('./react-commit-cascade-observer')

    const hook = readHook()
    for (let commit = 0; commit < REACT_COMMIT_CASCADE_NOTICE_LIMIT; commit += 1) {
      hook.onCommitFiberRoot?.(1, CASCADING_ROOT, undefined, false)
    }

    expect(recordBreadcrumb).toHaveBeenCalledWith(
      REACT_COMMIT_CASCADE_BREADCRUMB,
      expect.objectContaining({ commits: REACT_COMMIT_CASCADE_NOTICE_LIMIT })
    )
  })
})
