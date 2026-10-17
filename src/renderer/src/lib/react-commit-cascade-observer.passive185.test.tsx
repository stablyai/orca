/** @vitest-environment happy-dom */
// Why first: react-dom below reads __REACT_DEVTOOLS_GLOBAL_HOOK__ at module evaluation.
import { ensureReactDevtoolsCommitHook } from './react-devtools-commit-hook-shim'
import { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { withReactCommitCascadeWriteProbe } from '../store/react-commit-cascade-write-probe'
import {
  REACT_COMMIT_CASCADE_BREADCRUMB,
  REACT_COMMIT_CASCADE_NOTICE_LIMIT,
  resetReactCommitCascadeTelemetryForTests
} from './react-commit-cascade-telemetry'
import {
  installReactCommitCascadeObserver,
  resetReactCommitCascadeObserverForTests
} from './react-commit-cascade-observer'

// Why off: act() drains passive effects through its own queue, which is not the
// synchronous post-commit flush this file exists to cover.
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', false)

const recordBreadcrumb = vi.fn()
vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: (name: string, data?: unknown) => recordBreadcrumb(name, data)
}))

/** Far past React's 50-commit bail, so only #185 can end the loop. */
const RUNAWAY_TICKS = 200

type TickState = { ticks: number; advanceFromEffect: () => void }

const useTickStore = create<TickState>()(
  withReactCommitCascadeWriteProbe((set) => ({
    ticks: 0,
    advanceFromEffect: () => {
      set({ ticks: useTickStore.getState().ticks + 1 })
    }
  }))
)

let startLoop: (() => void) | null = null

/** useEffect, not useLayoutEffect: the write lands in React's post-commit passive flush. */
function RunawayPassiveEffectPane({ limit }: { limit: number }): React.JSX.Element {
  const ticks = useTickStore((state) => state.ticks)
  const [running, setRunning] = useState(false)
  startLoop = () => setRunning(true)
  useEffect(() => {
    if (running && ticks < limit) {
      useTickStore.getState().advanceFromEffect()
    }
  }, [running, ticks, limit])
  return <div>{ticks}</div>
}

let startStateLoop: (() => void) | null = null

/**
 * useState from a passive effect gets DefaultLane, whose commits flush passive
 * effects in a later task, so React resets its counter and this never throws.
 */
function DefaultLaneEffectLoopPane(): React.JSX.Element {
  const [ticks, setTicks] = useState(0)
  const [running, setRunning] = useState(false)
  startStateLoop = () => setRunning(true)
  useEffect(() => {
    if (running && ticks < RUNAWAY_TICKS) {
      setTicks(ticks + 1)
    }
  }, [running, ticks])
  return <div>{ticks}</div>
}

const commitHook = ensureReactDevtoolsCommitHook()

let host: HTMLDivElement
let root: Root
let uncaught: unknown[]

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function cascadeCalls(): unknown[][] {
  return recordBreadcrumb.mock.calls.filter(([name]) => name === REACT_COMMIT_CASCADE_BREADCRUMB)
}

beforeEach(async () => {
  recordBreadcrumb.mockReset()
  resetReactCommitCascadeTelemetryForTests()
  resetReactCommitCascadeObserverForTests()
  useTickStore.setState({ ticks: 0 })
  startLoop = null
  startStateLoop = null
  // Why cleared, not replaced: react-dom captured this hook object at module evaluation.
  if (commitHook) {
    commitHook.onCommitFiberRoot = undefined
    commitHook.onPostCommitFiberRoot = undefined
  }
  installReactCommitCascadeObserver()
  uncaught = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host, { onUncaughtError: (error) => uncaught.push(error) })
})

afterEach(() => {
  try {
    root.unmount()
  } catch {
    // Unmounting a root that already threw #185 is not under test.
  }
  host.remove()
})

describe('passive-effect commit cascade', () => {
  it('breadcrumbs a useEffect store-write loop before React throws #185', async () => {
    root.render(<RunawayPassiveEffectPane limit={RUNAWAY_TICKS} />)
    await settle(20)

    // A sync update makes React flush passive effects inside the commit, where
    // its nested-update counter reads the lanes the effect's write left behind.
    flushSync(() => startLoop?.())
    await settle(20)

    expect(String(uncaught[0])).toMatch(/Maximum update depth exceeded/)
    const calls = cascadeCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[1]).toMatchObject({
      commits: REACT_COMMIT_CASCADE_NOTICE_LIMIT,
      storeWrites: expect.any(Number),
      // The middleware boundary is elided, so this is the code that called `set`.
      driverFrame: expect.stringContaining('advanceFromEffect'),
      changedKeys: 'ticks'
    })
  })

  // Why asserted: an async passive flush runs after React already reset its
  // counter, so counting it would cry wolf on loops that never throw.
  it('stays silent for a default-lane useEffect loop React never throws on', async () => {
    root.render(<DefaultLaneEffectLoopPane />)
    await settle(20)

    startStateLoop?.()
    await settle(500)

    expect(uncaught).toEqual([])
    expect(host.textContent).toBe(String(RUNAWAY_TICKS))
    expect(cascadeCalls()).toEqual([])
  })
})
