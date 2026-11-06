import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetReactCommitCascadeTelemetryForTests } from './react-commit-cascade-telemetry'
import {
  installReactCommitCascadeObserver,
  resetReactCommitCascadeObserverForTests
} from './react-commit-cascade-observer'
import type { ReactDevtoolsCommitHook } from './react-devtools-commit-hook-shim'
import './react-devtools-commit-hook-shim'

const recordBreadcrumb = vi.fn()
vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: (name: string, data?: unknown) => recordBreadcrumb(name, data)
}))

function readHook(): ReactDevtoolsCommitHook {
  return (globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: ReactDevtoolsCommitHook })
    .__REACT_DEVTOOLS_GLOBAL_HOOK__ as ReactDevtoolsCommitHook
}

beforeEach(() => {
  recordBreadcrumb.mockClear()
  resetReactCommitCascadeTelemetryForTests()
  resetReactCommitCascadeObserverForTests()
  // Delete prior hooks so install cannot stack counters across tests.
  delete (globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__
  installReactCommitCascadeObserver()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('installReactCommitCascadeObserver', () => {
  // An escaping throw reaches React’s catch and silently skips DevTools/Fast Refresh chaining.
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
})
