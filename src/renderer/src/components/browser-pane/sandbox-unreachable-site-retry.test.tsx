// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  sandboxServerRetryDelayMs,
  SandboxUnreachableSiteState,
  type SandboxUnreachableSite
} from './sandbox-unreachable-site-state'

const server: SandboxUnreachableSite = {
  kind: 'sandbox-server',
  host: 'localhost:3000',
  url: 'http://localhost:3000/'
}
const outside: SandboxUnreachableSite = {
  kind: 'outside',
  host: 'example.com',
  url: 'https://example.com/'
}

function mount(site: SandboxUnreachableSite, props: { isActive: boolean; sandboxAwake: boolean }) {
  const onRetry = vi.fn()
  const view = render(
    <SandboxUnreachableSiteState
      site={site}
      errorName={null}
      onOpenInBrowser={() => {}}
      onRetry={onRetry}
      {...props}
    />
  )
  const rerender = (next: { isActive: boolean; sandboxAwake: boolean }) =>
    view.rerender(
      <SandboxUnreachableSiteState
        site={site}
        errorName={null}
        onOpenInBrowser={() => {}}
        onRetry={onRetry}
        {...next}
      />
    )
  return { onRetry, rerender }
}

const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms))

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('sandboxServerRetryDelayMs', () => {
  it('re-tries every 4 s, then every 15 s after 2 minutes, then stops at 10 minutes', () => {
    expect(sandboxServerRetryDelayMs(0)).toBe(4_000)
    expect(sandboxServerRetryDelayMs(119_999)).toBe(4_000)
    expect(sandboxServerRetryDelayMs(120_000)).toBe(15_000)
    expect(sandboxServerRetryDelayMs(599_999)).toBe(15_000)
    expect(sandboxServerRetryDelayMs(600_000)).toBeNull()
  })
})

describe('sandbox server re-try', () => {
  it('re-tries a visible tab on an awake sandbox, backs off, and stops', () => {
    const { onRetry } = mount(server, { isActive: true, sandboxAwake: true })
    advance(4_000)
    expect(onRetry).toHaveBeenCalledTimes(1)
    advance(116_000)
    expect(onRetry).toHaveBeenCalledTimes(30)
    advance(15_000)
    expect(onRetry).toHaveBeenCalledTimes(31)
    advance(20 * 60_000)
    const stopped = onRetry.mock.calls.length
    advance(10 * 60_000)
    expect(onRetry).toHaveBeenCalledTimes(stopped)
  })

  it('never re-tries while the sandbox is asleep, waking or going to sleep', () => {
    const { onRetry } = mount(server, { isActive: true, sandboxAwake: false })
    advance(60_000)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('pauses while the tab is hidden and re-arms the full schedule when it is shown again', () => {
    const { onRetry, rerender } = mount(server, { isActive: true, sandboxAwake: true })
    advance(11 * 60_000)
    const beforeHide = onRetry.mock.calls.length
    rerender({ isActive: false, sandboxAwake: true })
    advance(60_000)
    expect(onRetry).toHaveBeenCalledTimes(beforeHide)
    rerender({ isActive: true, sandboxAwake: true })
    advance(4_000)
    expect(onRetry).toHaveBeenCalledTimes(beforeHide + 1)
  })

  it('does not re-try outside hosts', () => {
    const { onRetry } = mount(outside, { isActive: true, sandboxAwake: true })
    advance(60_000)
    expect(onRetry).not.toHaveBeenCalled()
  })
})
