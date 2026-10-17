/** @vitest-environment happy-dom */
/**
 * Crash cluster: renderer React #185 on v1.4.199 (payloads 1789034235 `terminal.workbench`,
 * 1789077899 `sidebar.worktrees`; both carry `attribution: unreliable`).
 *
 * Neither payload contains a `react_commit_cascade` breadcrumb, and neither contains
 * `react_commit_cascade_uninstalled` — so the observer was installed, saw commits, and still
 * named nothing. This test shows why: the cascade shape that actually throws #185 in this app
 * is a store-subscription loop (an `useSyncExternalStore` snapshot that is not reference-stable,
 * i.e. a zustand selector handing back a fresh array/object), and that shape reports
 * `root.pendingLanes === 0` at every `onCommitFiberRoot` because `forceStoreRerender` runs from
 * a passive effect that react-dom flushes AFTER the devtools commit callback.
 *
 * react-commit-cascade-telemetry.ts resets the cascade on `(pendingLanes & REACT_CASCADING_LANES) === 0`,
 * so it ends the cascade on every one of those commits and never reaches its notice limit.
 */
import './react-devtools-commit-hook-shim'
import { Component, act, useSyncExternalStore, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REACT_NESTED_UPDATE_LIMIT } from '../../../shared/react-update-depth-attribution'
import {
  REACT_COMMIT_CASCADE_BREADCRUMB,
  resetReactCommitCascadeTelemetryForTests
} from './react-commit-cascade-telemetry'
import {
  installReactCommitCascadeObserver,
  resetReactCommitCascadeObserverForTests
} from './react-commit-cascade-observer'
import type { ReactDevtoolsCommitHook } from './react-devtools-commit-hook-shim'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const recordBreadcrumb = vi.fn()
vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: (name: string, data?: unknown) => recordBreadcrumb(name, data)
}))

const listeners = new Set<() => void>()
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * The production shape: a selector whose result is value-equal but never reference-equal.
 * Zustand v5's `useStore` is a bare `useSyncExternalStore(api.subscribe, () => selector(api.getState()))`,
 * so this is exactly what one uncached `.filter()` / `?? []` inside a `useAppStore` selector produces.
 */
const unstableSnapshot = (): readonly string[] => []

function UnstableStoreSnapshotPane(): React.JSX.Element {
  const rows = useSyncExternalStore(subscribe, unstableSnapshot, unstableSnapshot)
  return <div>{rows.length}</div>
}

class CapturingBoundary extends Component<{ children: ReactNode; onError: (e: unknown) => void }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  componentDidCatch(error: unknown): void {
    this.props.onError(error)
  }
  render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

const commitHook = (globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: ReactDevtoolsCommitHook })
  .__REACT_DEVTOOLS_GLOBAL_HOOK__

let host: HTMLDivElement
let root: Root
let pendingLanesPerCommit: number[]
let boundaryErrors: string[]

beforeEach(() => {
  recordBreadcrumb.mockReset()
  resetReactCommitCascadeTelemetryForTests()
  resetReactCommitCascadeObserverForTests()
  // Why cleared, not replaced: react-dom captured this hook object at its own module evaluation.
  if (commitHook) {
    commitHook.onCommitFiberRoot = undefined
  }
  installReactCommitCascadeObserver()
  pendingLanesPerCommit = []
  boundaryErrors = []
  const observed = commitHook?.onCommitFiberRoot
  if (commitHook) {
    commitHook.onCommitFiberRoot = (rendererId, fiberRoot, priorityLevel, didError) => {
      pendingLanesPerCommit.push(
        (fiberRoot as { pendingLanes?: number } | null)?.pendingLanes ?? -1
      )
      observed?.call(commitHook, rendererId, fiberRoot, priorityLevel, didError)
    }
  }
  // React's own dev warning for this shape is noise here; the assertions read the errors it throws.
  vi.spyOn(console, 'error').mockImplementation(() => {})
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host, {
    onCaughtError: (error) =>
      boundaryErrors.push(error instanceof Error ? error.message : String(error)),
    onUncaughtError: (error) =>
      boundaryErrors.push(error instanceof Error ? error.message : String(error))
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  listeners.clear()
  vi.restoreAllMocks()
})

function renderCascade(): void {
  act(() => {
    root.render(
      <CapturingBoundary onError={(error) => boundaryErrors.push(String(error))}>
        <UnstableStoreSnapshotPane />
      </CapturingBoundary>
    )
  })
}

describe('React #185 driven by an unstable store snapshot', () => {
  it('throws the production #185 message', () => {
    renderCascade()

    expect(
      boundaryErrors.some((message) => message.includes('Maximum update depth exceeded'))
    ).toBe(true)
    // React bails just past its nested-update limit, so the loop is short and leaves no trace.
    expect(pendingLanesPerCommit.length).toBeGreaterThan(REACT_NESTED_UPDATE_LIMIT)
  })

  it('reports pendingLanes 0 on every commit, so the cascade observer never arms', () => {
    renderCascade()

    expect(pendingLanesPerCommit.every((lanes) => lanes === 0)).toBe(true)
  })

  // FAILS on main: this is the diagnostic gap that leaves both production payloads
  // with a bystander boundary_id and nothing naming the driver.
  it('breadcrumbs the cascade before React throws', () => {
    renderCascade()

    const cascadeCrumbs = recordBreadcrumb.mock.calls.filter(
      ([name]) => name === REACT_COMMIT_CASCADE_BREADCRUMB
    )
    expect(cascadeCrumbs.length).toBe(1)
  })
})
