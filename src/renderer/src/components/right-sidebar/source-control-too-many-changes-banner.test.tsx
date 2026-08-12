// @vitest-environment happy-dom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooManyChangesBanner } from './SourceControl'

const { toastErrorMock } = vi.hoisted(() => ({ toastErrorMock: vi.fn() }))

vi.mock('sonner', () => ({ toast: { error: toastErrorMock } }))

describe('TooManyChangesBanner', () => {
  beforeEach(() => {
    toastErrorMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('aborts stale retry work when the banner unmounts', async () => {
    let retrySignal: AbortSignal | undefined
    const onRetry = vi.fn(
      (signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          retrySignal = signal
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )
    const view = render(<TooManyChangesBanner limit={1_000} onRetry={onRetry} />)

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(retrySignal?.aborted).toBe(false)

    view.unmount()

    await waitFor(() => expect(retrySignal?.aborted).toBe(true))
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('bounds a hung retry and restores the action', async () => {
    vi.useFakeTimers()
    const onRetry = vi.fn(
      (signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )
    render(<TooManyChangesBanner limit={1_000} onRetry={onRetry} />)

    const retryButton = screen.getByRole('button', { name: 'Retry' })
    fireEvent.click(retryButton)
    expect((retryButton as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })

    expect((retryButton as HTMLButtonElement).disabled).toBe(false)
    expect(toastErrorMock).toHaveBeenCalledWith('Could not refresh Source Control. Try again.')
  })
})
