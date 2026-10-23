// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StalledTerminalDaemonBanner } from './StalledTerminalDaemonBanner'
import type { DaemonAsyncIoStatus } from '../../../../shared/daemon-async-io-health'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const owner = { protocolVersion: 1, pid: 100, startedAtMs: 123, launchNonce: 'owner' }
const sessions = [
  { sessionId: 'affected-terminal', incarnationId: 'incarnation', cwd: '/project', pid: 200 }
]
const reviewStalledDaemon = vi.fn()
const restartStalledDaemon = vi.fn()

const readHealth = vi.fn<() => Promise<DaemonAsyncIoStatus>>()

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  reviewStalledDaemon.mockResolvedValue({ status: 'ready', owner, sessions })
  restartStalledDaemon.mockResolvedValue({ status: 'restarted', killedCount: 1 })
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      pty: { management: { asyncIoHealth: readHealth, reviewStalledDaemon, restartStalledDaemon } }
    }
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

async function mount(): Promise<void> {
  await act(async () => {
    render(<StalledTerminalDaemonBanner />)
  })
}

it('reviews the exact affected terminals before targeting their service', async () => {
  readHealth.mockResolvedValue({
    state: 'stalled',
    pendingMs: 5000,
    owner,
    recoverySupported: true
  })
  await mount()
  expect(screen.getByRole('alert').textContent).toContain('Typing and new terminals may not work')
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Review restart options' }))
  })
  expect(reviewStalledDaemon).toHaveBeenCalledWith(owner)
  expect(screen.getByRole('dialog').textContent).toContain('/project')
  expect(screen.getByRole('dialog').textContent).toContain('affected-terminal')
  expect(restartStalledDaemon).not.toHaveBeenCalled()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Restart affected service' }))
  })
  expect(restartStalledDaemon).toHaveBeenCalledWith({ owner, sessions })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('offers no generic restart when the peer lacks owner targeting', async () => {
  readHealth.mockResolvedValue({ state: 'stalled', pendingMs: 5000 })
  await mount()
  expect(screen.getByRole('alert')).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
})

it('requires a new review when the restart is refused', async () => {
  readHealth.mockResolvedValue({
    state: 'stalled',
    pendingMs: 5000,
    owner,
    recoverySupported: true
  })
  restartStalledDaemon.mockResolvedValue({ status: 'refused' })
  await mount()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Review restart options' }))
  })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Restart affected service' }))
  })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('status').textContent).toContain('Review the affected terminals again')
})

it('clears an existing warning when the peer reports unsupported', async () => {
  readHealth.mockResolvedValue({
    state: 'stalled',
    pendingMs: 5000,
    owner,
    recoverySupported: true
  })
  await mount()
  readHealth.mockResolvedValue({ state: 'unsupported' })
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
  })
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each(['healthy', 'unsupported', 'unverifiable'] as const)(
  'does not warn on %s',
  async (state) => {
    readHealth.mockResolvedValue(state === 'healthy' ? { state, pendingMs: 0 } : { state })
    await mount()
    expect(screen.queryByRole('alert')).toBeNull()
  }
)

it('clears a proven stall on recovery, and does no work while hidden or after unmount', async () => {
  readHealth.mockResolvedValue({
    state: 'stalled',
    pendingMs: 5000,
    owner,
    recoverySupported: true
  })
  await mount()
  expect(screen.getByRole('alert')).toBeTruthy()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000)
  })
  expect(readHealth).toHaveBeenCalledTimes(1)
  readHealth.mockResolvedValue({ state: 'healthy', pendingMs: 0 })
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(readHealth).toHaveBeenCalledTimes(2)
  cleanup()
  await vi.advanceTimersByTimeAsync(60_000)
  window.dispatchEvent(new Event('focus'))
  expect(readHealth).toHaveBeenCalledTimes(2)
})

it('coalesces focus and interval checks while a request is pending', async () => {
  readHealth.mockImplementation(() => new Promise(() => {}))
  await mount()
  window.dispatchEvent(new Event('focus'))
  await vi.advanceTimersByTimeAsync(60_000)
  expect(readHealth).toHaveBeenCalledTimes(1)
})

it('keeps a proven stall visible when contact is lost, until progress is observed', async () => {
  readHealth.mockResolvedValue({
    state: 'stalled',
    pendingMs: 5000,
    owner,
    recoverySupported: true
  })
  await mount()
  readHealth.mockResolvedValue({ state: 'unverifiable' })
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
  })
  expect(screen.getByRole('alert')).toBeTruthy()
  readHealth.mockRejectedValue(new Error('Connection lost'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000)
  })
  expect(screen.getByRole('alert')).toBeTruthy()
  readHealth.mockResolvedValue({ state: 'healthy', pendingMs: 0 })
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
  })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('keeps confirmation disabled while restart is pending and invalidates unknown results', async () => {
  readHealth.mockResolvedValue({
    state: 'stalled',
    pendingMs: 5000,
    owner,
    recoverySupported: true
  })
  let rejectRestart: ((reason: Error) => void) | undefined
  restartStalledDaemon.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        rejectRestart = reject
      })
  )
  await mount()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Review restart options' }))
  })
  await act(async () => {
    const button = screen.getByRole('button', { name: 'Restart affected service' })
    fireEvent.click(button)
  })
  const button = screen.getByRole('button', { name: 'Restart affected service' })
  expect(button.hasAttribute('disabled')).toBe(true)
  fireEvent.click(button)
  expect(restartStalledDaemon).toHaveBeenCalledOnce()
  await act(async () => {
    rejectRestart?.(new Error('Connection lost'))
  })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('status').textContent).toContain('Restart could not be confirmed')
})

it('does not confirm when the owner review is refused', async () => {
  readHealth.mockResolvedValue({
    state: 'stalled',
    pendingMs: 5000,
    owner,
    recoverySupported: true
  })
  reviewStalledDaemon.mockResolvedValue({ status: 'refused' })
  await mount()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Review restart options' }))
  })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(restartStalledDaemon).not.toHaveBeenCalled()
})
