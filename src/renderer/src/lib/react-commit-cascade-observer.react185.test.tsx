/** @vitest-environment happy-dom */
// Why first: react-dom below reads __REACT_DEVTOOLS_GLOBAL_HOOK__ at module
// evaluation. The shim has no imports of its own, so unlike the observer it
// cannot drag the real breadcrumb recorder in ahead of the vi.mock below.
import './react-devtools-commit-hook-shim'
import { act, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { withReactCommitCascadeWriteProbe } from '../store/react-commit-cascade-write-probe'
import {
  REACT_CASCADING_LANES,
  REACT_COMMIT_CASCADE_BREADCRUMB,
  REACT_COMMIT_CASCADE_NOTICE_LIMIT,
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

/** Enough to pass the notice limit while staying under React's own 50-commit bail. */
const CASCADE_TICKS = REACT_COMMIT_CASCADE_NOTICE_LIMIT + 5

type CascadeState = { ticks: number; bump: () => void }

const useCascadeStore = create<CascadeState>()(
  withReactCommitCascadeWriteProbe((set) => ({
    ticks: 0,
    bump: () => {
      set({ ticks: useCascadeStore.getState().ticks + 1 })
    }
  }))
)

// Only synchronous layout-effect loops throw #185; passive effects leave pendingLanes zero at commit and only console.error.
function RunawayLayoutEffectPane(): React.JSX.Element {
  const ticks = useCascadeStore((state) => state.ticks)
  useLayoutEffect(() => {
    if (ticks < CASCADE_TICKS) {
      useCascadeStore.getState().bump()
    }
  })
  return <div>{ticks}</div>
}

let host: HTMLDivElement
let root: Root

const commitHook = (globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: ReactDevtoolsCommitHook })
  .__REACT_DEVTOOLS_GLOBAL_HOOK__

beforeEach(() => {
  recordBreadcrumb.mockReset()
  resetReactCommitCascadeTelemetryForTests()
  resetReactCommitCascadeObserverForTests()
  useCascadeStore.setState({ ticks: 0 })
  // Clear the captured hook object in place; replacement is invisible to react-dom, while rewrapping old counters doubles counts.
  if (commitHook) {
    commitHook.onCommitFiberRoot = undefined
  }
  installReactCommitCascadeObserver()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  host.remove()
})

describe('react commit cascade observer', () => {
  it('counts a genuine synchronous cascade and names the store write driving it', () => {
    act(() => {
      root.render(<RunawayLayoutEffectPane />)
    })

    const cascadeCalls = recordBreadcrumb.mock.calls.filter(
      ([name]) => name === REACT_COMMIT_CASCADE_BREADCRUMB
    )
    expect(cascadeCalls).toHaveLength(1)

    const payload = (cascadeCalls[0]?.[1] ?? {}) as Record<string, unknown>
    expect(payload.commits).toBe(REACT_COMMIT_CASCADE_NOTICE_LIMIT)
    expect(payload.pendingLanes).toBeGreaterThan(0)
    expect(payload.storeWrites).toBeGreaterThan(0)
    // The middleware boundary is elided, so this is the code that called `set`.
    expect(String(payload.driverFrame)).toContain('bump')
    expect(payload.changedKeys).toBe('ticks')
    expect(payload.rendererSurface).toBe('main')
  })

  // Count outside our wrapper to detect duplicate observer installation, which otherwise reports at half the true depth.
  it('counts exactly one commit per hook invocation', () => {
    let cascadingInvocations = 0
    const observed = commitHook?.onCommitFiberRoot
    if (commitHook) {
      // The mount commit holds no cascading lanes, so only these are countable.
      commitHook.onCommitFiberRoot = (rendererId, fiberRoot, priorityLevel, didError) => {
        const lanes = (fiberRoot as { pendingLanes?: number } | null)?.pendingLanes ?? 0
        if ((lanes & REACT_CASCADING_LANES) !== 0) {
          cascadingInvocations += 1
        }
        observed?.call(commitHook, rendererId, fiberRoot, priorityLevel, didError)
      }
    }
    let invocationsAtReport: number | undefined
    recordBreadcrumb.mockImplementation((name: string) => {
      if (name === REACT_COMMIT_CASCADE_BREADCRUMB && invocationsAtReport === undefined) {
        invocationsAtReport = cascadingInvocations
      }
    })

    act(() => {
      root.render(<RunawayLayoutEffectPane />)
    })

    expect(invocationsAtReport).toBe(REACT_COMMIT_CASCADE_NOTICE_LIMIT)
  })

  it('stays silent for a render that settles well below the notice limit', () => {
    useCascadeStore.setState({ ticks: CASCADE_TICKS })

    act(() => {
      root.render(<RunawayLayoutEffectPane />)
    })

    expect(recordBreadcrumb).not.toHaveBeenCalled()
  })
})
