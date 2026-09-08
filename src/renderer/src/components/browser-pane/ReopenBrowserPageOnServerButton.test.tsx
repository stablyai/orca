// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const reopenMocks = vi.hoisted(() => ({ reopenBrowserPageOnServer: vi.fn() }))

vi.mock('./browser-reopen-on-server', () => ({
  reopenBrowserPageOnServer: reopenMocks.reopenBrowserPageOnServer
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { ReopenBrowserPageOnServerButton } from './ReopenBrowserPageOnServerButton'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

function renderButton(): HTMLElement {
  render(
    <ReopenBrowserPageOnServerButton
      environmentId="environment-a"
      worktreeId="worktree-a"
      lastCommittedUrl="https://example.internal/report"
    />
  )
  return screen.getByRole('button')
}

// Tailwind's `invisible` never resolves in the test DOM, so read the rendered state
// from the class and the accessibility flag both labels carry.
function shown(text: string): boolean {
  const label = screen.getByText(text)
  return !label.className.includes('invisible') && label.getAttribute('aria-hidden') === 'false'
}

describe('ReopenBrowserPageOnServerButton', () => {
  it('swaps in a spinner label once the remote round-trip outlasts the defer window', async () => {
    vi.useFakeTimers()
    let settle = (): void => {}
    reopenMocks.reopenBrowserPageOnServer.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          settle = () => resolve(true)
        })
    )
    const button = renderButton()

    fireEvent.click(button)

    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(shown('Reopening…')).toBe(false)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })

    expect(shown('Reopening…')).toBe(true)
    expect(shown('Reopen on server')).toBe(false)

    await act(async () => {
      settle()
      await Promise.resolve()
    })

    expect(button).not.toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'false')
    expect(shown('Reopen on server')).toBe(true)
    expect(shown('Reopening…')).toBe(false)
  })

  it('never flashes the spinner for a round-trip that settles quickly', async () => {
    vi.useFakeTimers()
    reopenMocks.reopenBrowserPageOnServer.mockResolvedValue(true)
    const button = renderButton()

    await act(async () => {
      fireEvent.click(button)
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(shown('Reopening…')).toBe(false)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })

    expect(shown('Reopening…')).toBe(false)
    expect(button).not.toBeDisabled()
  })

  it('rejects a second click while the first is still running', () => {
    reopenMocks.reopenBrowserPageOnServer.mockImplementation(() => new Promise<boolean>(() => {}))
    const button = renderButton()

    fireEvent.click(button)
    fireEvent.click(button)

    expect(reopenMocks.reopenBrowserPageOnServer).toHaveBeenCalledTimes(1)
  })
})
