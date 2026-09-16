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

/**
 * A single-driver cascade measures 438 bytes here, where every frame carries this
 * file's long basename; a production bundle name is shorter. Wide enough to sit
 * still, narrow enough that a raw stack or an uncapped key list breaks it.
 */
const MAX_CASCADE_CRUMB_BYTES = 768

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

/**
 * Layout effect, not passive: only the synchronous counter throws #185. A
 * useEffect loop leaves `pendingLanes: 0` at commit time (measured) because
 * passive effects flush after the callback, and React only console.errors it.
 */
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
  // Why cleared rather than deleting the global: react-dom captured this hook
  // OBJECT at its own module evaluation, so a replacement object would never be
  // called — and reinstalling over the last test's wrapper double-counts commits.
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

  // Why counted from outside our own wrapper: a bundler change that installs the
  // observer twice counts every commit twice and fires the crumb at half the real
  // depth, which no other assertion here can tell from a correct run.
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

  // Why a byte budget: driverStack's key ends in `stack`, which buys 4000 chars,
  // so a raw stack or an uncapped key list could be added here unnoticed.
  it('keeps the crumb inside a flat byte budget', () => {
    act(() => {
      root.render(<RunawayLayoutEffectPane />)
    })

    const payload = recordBreadcrumb.mock.calls.find(
      ([name]) => name === REACT_COMMIT_CASCADE_BREADCRUMB
    )?.[1]
    expect(JSON.stringify(payload).length).toBeLessThan(MAX_CASCADE_CRUMB_BYTES)
  })

  it('stays silent for a render that settles well below the notice limit', () => {
    useCascadeStore.setState({ ticks: CASCADE_TICKS })

    act(() => {
      root.render(<RunawayLayoutEffectPane />)
    })

    expect(recordBreadcrumb).not.toHaveBeenCalled()
  })
})
