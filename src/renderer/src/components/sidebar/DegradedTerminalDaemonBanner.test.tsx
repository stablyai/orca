// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DegradedTerminalDaemonBanner } from './DegradedTerminalDaemonBanner'

const { openManageSessions } = vi.hoisted(() => ({ openManageSessions: vi.fn() }))
vi.mock('../settings/open-terminal-manage-sessions', () => ({
  openTerminalManageSessions: openManageSessions
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const listSessions = vi.fn<() => Promise<{ sessions: never[]; degraded: boolean }>>()

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { pty: { management: { listSessions } } }
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

async function mount(): Promise<void> {
  await act(async () => {
    render(<DegradedTerminalDaemonBanner />)
  })
}

it('explains degraded mode and opens the restart review without stopping anything', async () => {
  listSessions.mockResolvedValue({ sessions: [], degraded: true })
  await mount()
  expect(screen.getByRole('alert').textContent).toContain('new terminals run inside Orca')
  expect(screen.getByRole('alert').textContent).toContain(
    'Restarting the terminal service now ends them'
  )
  fireEvent.click(screen.getByRole('button', { name: 'Review restart options' }))
  expect(openManageSessions).toHaveBeenCalledOnce()
})

it('stays hidden while fresh terminals are daemon-backed', async () => {
  listSessions.mockResolvedValue({ sessions: [], degraded: false })
  await mount()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('clears once routing recovers, and does no work while hidden or after unmount', async () => {
  listSessions.mockResolvedValue({ sessions: [], degraded: true })
  await mount()
  expect(screen.getByRole('alert')).toBeTruthy()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000)
  })
  expect(listSessions).toHaveBeenCalledTimes(1)
  listSessions.mockResolvedValue({ sessions: [], degraded: false })
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(listSessions).toHaveBeenCalledTimes(2)
  cleanup()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000)
  })
  expect(listSessions).toHaveBeenCalledTimes(2)
})

it('keeps the last answer when a read fails', async () => {
  listSessions.mockResolvedValueOnce({ sessions: [], degraded: true })
  await mount()
  listSessions.mockRejectedValueOnce(new Error('ipc closed'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000)
  })
  expect(screen.getByRole('alert')).toBeTruthy()
})
