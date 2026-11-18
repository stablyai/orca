// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRCheckDetail } from '../../../../../../shared/github/checks/check-types'
import type { PRAutoRefreshCadence } from '../../../../../../shared/source-control/hosted-review/review-refresh-policy'
import { createModel } from './checks-panel-polling-test-model'

const host = vi.hoisted(() => {
  const state: { cadence: PRAutoRefreshCadence } = { cadence: 'default' }
  return state
})
vi.mock('@/store/github/refresh/remote-host-pr-auto-refresh-cadence', () => ({
  hostPRAutoRefreshCadence: () => host.cadence
}))
vi.mock('@/store/github/repositories/repository-routing', () => ({
  getPRRefreshOwnerRuntimeEnvironmentId: () => null
}))
import { useChecksPanelPolling } from './use-checks-panel-polling'

const guardian: PRCheckDetail = {
  name: 'GitGuardian',
  status: 'completed',
  conclusion: 'success',
  url: null
}
const buildRunning: PRCheckDetail = {
  name: 'build',
  status: 'in_progress',
  conclusion: 'pending',
  url: null
}
const buildPassed: PRCheckDetail = {
  name: 'build',
  status: 'completed',
  conclusion: 'success',
  url: null
}
const running = [guardian, buildRunning]
const passed = [guardian, buildPassed]

const focusWindow = () => window.dispatchEvent(new Event('focus'))
function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state })
  document.dispatchEvent(new Event('visibilitychange'))
}

function mountPanel(provider: () => Promise<PRCheckDetail[]>) {
  const fetchPRChecks = vi.fn(provider)
  const model = createModel({ fetchPRChecks, pollIntervalRef: { current: 60_000 } })
  renderHook(() => useChecksPanelPolling(model))
  const shown = () => vi.mocked(model.setChecks).mock.calls.at(-1)?.[0]
  return { fetchPRChecks, model, shown }
}

beforeEach(() => {
  host.cadence = 'default'
  vi.useFakeTimers()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('returning to the window while checks are running', () => {
  it('shows a check that finished while away as soon as the window is focused again', async () => {
    let providerChecks = running
    const { fetchPRChecks, shown } = mountPanel(async () => providerChecks)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(shown()).toEqual(running)

    providerChecks = passed
    // Before the 60 s timer: only the user coming back can surface the finish.
    await vi.advanceTimersByTimeAsync(30_000)
    focusWindow()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(shown()).toEqual(passed)
    // A fresh read: no renderer cache, and a paired host must not answer from its last read.
    const options = fetchPRChecks.mock.calls.at(-1)?.at(-1)
    expect(options).toMatchObject({ force: true })
    expect(options).not.toHaveProperty('background')
  })

  it('reads when the window becomes visible again', async () => {
    let providerChecks = running
    const { shown } = mountPanel(async () => providerChecks)
    await vi.advanceTimersByTimeAsync(1_000)
    setVisibility('hidden')
    providerChecks = passed
    await vi.advanceTimersByTimeAsync(20_000)
    setVisibility('visible')
    await vi.advanceTimersByTimeAsync(1_000)

    expect(shown()).toEqual(passed)
  })

  it('reads on return when PR auto-refresh is off', async () => {
    host.cadence = 'off'
    let providerChecks = running
    const { shown } = mountPanel(async () => providerChecks)
    await vi.advanceTimersByTimeAsync(1_000)
    providerChecks = passed
    await vi.advanceTimersByTimeAsync(20_000)
    focusWindow()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(shown()).toEqual(passed)
  })
})
