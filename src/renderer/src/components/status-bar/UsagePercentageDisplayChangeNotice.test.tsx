// @vitest-environment happy-dom

import { act, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UsagePercentageDisplayChangeNotice } from './UsagePercentageDisplayChangeNotice'

type ResizeObserverStub = { cb: ResizeObserverCallback; targets: Element[] }
const resizeObservers: ResizeObserverStub[] = []

function fireResizeObservers(): void {
  for (const observer of resizeObservers) {
    if (observer.targets.length === 0) {
      continue
    }
    observer.cb([] as unknown as ResizeObserverEntry[], observer as unknown as ResizeObserver)
  }
}

const storeState = {
  persistedUIReady: true,
  usagePercentageDisplayChangeNoticeDismissed: false,
  dismissUsagePercentageDisplayChangeNotice: vi.fn(),
  statusBarVisible: true,
  activeModal: 'none' as string,
  openSettingsTarget: vi.fn(),
  openSettingsPage: vi.fn()
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    {
      getState: () => storeState
    }
  )
}))

describe('UsagePercentageDisplayChangeNotice', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    resizeObservers.length = 0
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      cb: ResizeObserverCallback
      targets: Element[] = []
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb
        resizeObservers.push({ cb, targets: this.targets })
      }
      observe(el: Element): void {
        this.targets.push(el)
      }
      unobserve(): void {}
      disconnect(): void {
        this.targets.length = 0
      }
    }
    storeState.persistedUIReady = true
    storeState.usagePercentageDisplayChangeNoticeDismissed = false
    storeState.statusBarVisible = true
    storeState.activeModal = 'none'
    storeState.dismissUsagePercentageDisplayChangeNotice = vi.fn()
    storeState.openSettingsPage = vi.fn()
    storeState.openSettingsTarget = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    // Why: fixed positioning reads getBoundingClientRect; happy-dom needs a
    // non-zero layout box so the portal card is measured and mounted.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          x: 24,
          y: 700,
          top: 700,
          left: 24,
          bottom: 724,
          right: 200,
          width: 176,
          height: 24,
          toJSON: () => ({})
        }) satisfies DOMRect
    )
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    document.querySelectorAll('.status-bar-change-notice-card').forEach((node) => node.remove())
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('does not re-render on ResizeObserver deliveries with unchanged geometry', () => {
    let commits = 0
    act(() => {
      root.render(
        <Profiler
          id="notice"
          onRender={() => {
            commits++
          }}
        >
          <UsagePercentageDisplayChangeNotice hasVisibleUsageMeters>
            <span>usage-meters</span>
          </UsagePercentageDisplayChangeNotice>
        </Profiler>
      )
    })
    act(() => {
      vi.advanceTimersByTime(1_800)
    })
    expect(document.querySelector('.status-bar-change-notice-card')).not.toBeNull()
    const commitsAfterOpen = commits

    for (let i = 0; i < 20; i++) {
      act(() => {
        fireResizeObservers()
      })
    }
    // Equal-geometry deliveries must reuse state instead of adding a render per observer callback.
    expect(commits - commitsAfterOpen).toBeLessThanOrEqual(1)
  })
})
