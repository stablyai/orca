// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StalledTerminalDaemonBanner } from './StalledTerminalDaemonBanner'
import type { DaemonAsyncIoStatus } from '../../../../shared/daemon-async-io-health'

const { openManageSessions } = vi.hoisted(() => ({ openManageSessions: vi.fn() }))
vi.mock('../settings/open-terminal-manage-sessions', () => ({
  openTerminalManageSessions: openManageSessions
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const readHealth = vi.fn<() => Promise<DaemonAsyncIoStatus>>()

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { pty: { management: { asyncIoHealth: readHealth } } }
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

it('shows a persistent explanation and opens the existing restart review without stopping anything', async () => {
  readHealth.mockResolvedValue({ state: 'stalled', pendingMs: 5000 })
  await mount()
  expect(screen.getByRole('alert').textContent).toContain('Typing and new terminals may not work')
  expect(screen.getByRole('alert').textContent).toContain('ends its running terminals and commands')
  fireEvent.click(screen.getByRole('button', { name: 'Review restart options' }))
  expect(openManageSessions).toHaveBeenCalledOnce()
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
  readHealth.mockResolvedValue({ state: 'stalled', pendingMs: 5000 })
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
  readHealth.mockResolvedValue({ state: 'stalled', pendingMs: 5000 })
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
