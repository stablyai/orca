// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DaemonStartupFallbackBanner } from './DaemonStartupFallbackBanner'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const readFallback = vi.fn<() => Promise<{ freshTerminalsInProcess: boolean }>>()

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { pty: { management: { startupFallback: readFallback } } }
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

async function mount(): Promise<void> {
  await act(async () => {
    render(<DaemonStartupFallbackBanner />)
  })
}

it('tells the user terminals close on quit and how to start the terminal service again', async () => {
  readFallback.mockResolvedValue({ freshTerminalsInProcess: true })
  await mount()
  const alert = screen.getByRole('alert').textContent
  expect(alert).toContain('Terminals will close when Orca quits')
  expect(alert).toContain('quit and reopen Orca to start the terminal service again')
})

it('stays hidden while terminals are daemon-backed', async () => {
  readFallback.mockResolvedValue({ freshTerminalsInProcess: false })
  await mount()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('hides once a daemon takes fresh terminals back, and keeps the warning when contact is lost', async () => {
  readFallback.mockResolvedValue({ freshTerminalsInProcess: true })
  await mount()
  readFallback.mockRejectedValue(new Error('Connection lost'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000)
  })
  expect(screen.getByRole('alert')).toBeTruthy()
  readFallback.mockResolvedValue({ freshTerminalsInProcess: false })
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
  })
  expect(screen.queryByRole('alert')).toBeNull()
})
