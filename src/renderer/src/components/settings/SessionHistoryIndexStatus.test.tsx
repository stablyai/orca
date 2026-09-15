// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { unavailableSessionSearchStatus } from '../../../../shared/ai-vault-search-client'
import type { AiVaultSearchStatus } from '../../../../shared/ai-vault-search-types'
import { SessionHistoryIndexStatus } from './SessionHistoryIndexStatus'

const mocks = vi.hoisted(() => ({ visible: true, status: vi.fn() }))
vi.mock('@/hooks/use-window-stream-visibility', () => ({
  useWindowStreamVisible: () => mocks.visible
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, args?: Record<string, unknown>) =>
    fallback.replace(/{{(\w+)}}/g, (_, key: string) => String(args?.[key]))
}))

const current: AiVaultSearchStatus = {
  ...unavailableSessionSearchStatus(),
  enabled: true,
  phase: 'current',
  filesIndexed: 12,
  lastSweepCompletedAt: 1
}
beforeEach(() => {
  vi.useFakeTimers()
  mocks.visible = true
  mocks.status.mockReset().mockResolvedValue(current)
  vi.stubGlobal('api', undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { aiVault: { searchStatus: mocks.status } }
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('keeps polling a settled index so counts stay live between sweeps', async () => {
  render(<SessionHistoryIndexStatus enabled refresh={0} />)
  await act(async () => {})
  expect(mocks.status).toHaveBeenCalledWith('local')
  expect(screen.getByRole('status')).toHaveTextContent('Up to date · 12 files indexed')
  mocks.status.mockResolvedValue({ ...current, filesIndexed: 30 })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000)
  })
  expect(screen.getByRole('status')).toHaveTextContent('Up to date · 30 files indexed')
})

it('reports a first scan by count and later sweeps by percentage', async () => {
  mocks.status.mockResolvedValue({
    ...current,
    phase: 'indexing',
    filesIndexed: 4,
    filesDue: 6,
    lastSweepCompletedAt: null
  })
  render(<SessionHistoryIndexStatus enabled refresh={0} />)
  await act(async () => {})
  expect(screen.getByRole('status')).toHaveTextContent('Indexing… 4 files so far')
  expect(screen.getByRole('status')).toHaveTextContent('Turn off search to stop')
  mocks.status.mockResolvedValue({
    ...current,
    phase: 'indexing',
    filesIndexed: 4,
    filesDue: 5,
    filesFailed: 1,
    lastSweepCompletedAt: 1
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000)
  })
  expect(screen.getByRole('status')).toHaveTextContent('Indexing · 40% · 4 of 10 files')
})

it('polls a sweep faster than a settled index', async () => {
  mocks.status.mockResolvedValue({ ...current, phase: 'indexing', filesDue: 3 })
  render(<SessionHistoryIndexStatus enabled refresh={0} />)
  await act(async () => {})
  const started = mocks.status.mock.calls.length
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6_000)
  })
  expect(mocks.status.mock.calls.length - started).toBe(3)
})

it('names unreadable files while degraded and still reports progress', async () => {
  mocks.status.mockResolvedValue({
    ...current,
    phase: 'degraded',
    filesIndexed: 8,
    filesDue: 1,
    filesFailed: 1,
    degradedRoots: [{ reason: 'unreadable' }]
  })
  render(<SessionHistoryIndexStatus enabled refresh={0} />)
  await act(async () => {})
  const status = screen.getByRole('status')
  expect(status).toHaveTextContent('Indexing · 80% · 8 of 10 files')
  expect(status).toHaveTextContent('1 files could not be read and will be retried.')
  expect(status).toHaveTextContent('Unverified source roots: 1')
})

it('calls a drained degraded index up to date', async () => {
  mocks.status.mockResolvedValue({
    ...current,
    phase: 'degraded',
    filesIndexed: 9,
    filesDue: 0,
    filesFailed: 2
  })
  render(<SessionHistoryIndexStatus enabled refresh={0} />)
  await act(async () => {})
  expect(screen.getByRole('status')).toHaveTextContent('Up to date · 9 files indexed')
  expect(screen.getByRole('status')).toHaveTextContent('2 files could not be read')
  expect(screen.queryByText(/Turn off search to stop/)).not.toBeInTheDocument()
})

it('offers no refresh control now that status is live', async () => {
  render(<SessionHistoryIndexStatus enabled refresh={0} />)
  await act(async () => {})
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})

it('does not describe an absent service as an empty current index', async () => {
  mocks.status.mockResolvedValue(unavailableSessionSearchStatus())
  render(<SessionHistoryIndexStatus enabled refresh={0} />)
  await act(async () => {})
  expect(screen.getByRole('status')).toHaveTextContent(
    'not ready or the search service is unavailable'
  )
  expect(screen.queryByText(/files indexed/)).not.toBeInTheDocument()
})

it('recovers on its own after a failed read', async () => {
  mocks.status.mockRejectedValueOnce(new Error('offline'))
  render(<SessionHistoryIndexStatus enabled refresh={0} />)
  await act(async () => {})
  expect(screen.getByRole('status')).toHaveTextContent('Could not read index status')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000)
  })
  expect(screen.getByRole('status')).toHaveTextContent('Up to date · 12 files indexed')
})

it('handles a synchronous bridge failure without losing the poll', async () => {
  mocks.status.mockImplementationOnce(() => {
    throw new Error('bridge unavailable')
  })
  render(<SessionHistoryIndexStatus enabled refresh={0} />)
  await act(async () => {})
  expect(screen.getByRole('status')).toHaveTextContent('Could not read index status')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000)
  })
  expect(screen.getByRole('status')).toHaveTextContent('Up to date · 12 files indexed')
})

it('fences pending responses across disable and hiding', async () => {
  let answer: (value: AiVaultSearchStatus) => void = () => undefined
  mocks.status.mockReturnValue(
    new Promise<AiVaultSearchStatus>((resolve) => {
      answer = resolve
    })
  )
  const view = render(<SessionHistoryIndexStatus enabled refresh={0} />)
  view.rerender(<SessionHistoryIndexStatus enabled={false} refresh={0} />)
  await act(async () => {
    answer(current)
  })
  expect(screen.getByRole('status')).toHaveTextContent('Search is off')
  expect(screen.queryByText(/files indexed/)).not.toBeInTheDocument()
  mocks.visible = false
  view.rerender(<SessionHistoryIndexStatus enabled refresh={0} />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000)
  })
  expect(mocks.status).toHaveBeenCalledTimes(1)
  mocks.visible = true
  mocks.status.mockResolvedValue(current)
  view.rerender(<SessionHistoryIndexStatus enabled refresh={1} />)
  await act(async () => {})
  expect(mocks.status).toHaveBeenCalledTimes(2)
})

it('does not overlap slow status requests and stops polling on unmount', async () => {
  let answer: (value: AiVaultSearchStatus) => void = () => undefined
  mocks.status.mockReturnValue(
    new Promise<AiVaultSearchStatus>((resolve) => {
      answer = resolve
    })
  )
  const view = render(<SessionHistoryIndexStatus enabled refresh={0} />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000)
  })
  expect(mocks.status).toHaveBeenCalledTimes(1)
  await act(async () => {
    answer({ ...current, phase: 'indexing', filesDue: 2 })
  })
  const beforeUnmount = mocks.status.mock.calls.length
  view.unmount()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000)
  })
  expect(mocks.status).toHaveBeenCalledTimes(beforeUnmount)
})
