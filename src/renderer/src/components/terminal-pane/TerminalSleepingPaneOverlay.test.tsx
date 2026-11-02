// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalSleepingPaneOverlay } from './TerminalSleepingPaneOverlay'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

afterEach(cleanup)

describe('TerminalSleepingPaneOverlay', () => {
  it('says the session is asleep, why, and that it is saved', () => {
    render(<TerminalSleepingPaneOverlay reason="paused" onResume={vi.fn()} />)

    expect(screen.getByText('Sleeping — click to resume')).toBeInTheDocument()
    expect(screen.getByText(/paused because the host stopped unexpectedly/)).toBeInTheDocument()
    expect(screen.getByText(/Your session is saved/)).toBeInTheDocument()
  })

  it('resumes once from the button and from anywhere on the pane', async () => {
    const onResume = vi.fn()
    const user = userEvent.setup()
    render(<TerminalSleepingPaneOverlay reason="live_cap" onResume={onResume} />)

    await user.click(screen.getByRole('button', { name: 'Resume' }))
    expect(onResume).toHaveBeenCalledOnce()
    await user.click(screen.getByText('Sleeping — click to resume'))
    expect(onResume).toHaveBeenCalledTimes(2)
  })

  it('offers to resume automatic restores only when the host can clear its pause', async () => {
    const onResume = vi.fn()
    const onResumeAutomaticRestores = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(<TerminalSleepingPaneOverlay reason="paused" onResume={onResume} />)
    expect(screen.queryByRole('button', { name: 'Resume automatic restores' })).toBeNull()

    rerender(
      <TerminalSleepingPaneOverlay
        reason="paused"
        onResume={onResume}
        onResumeAutomaticRestores={onResumeAutomaticRestores}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Resume automatic restores' }))
    expect(onResumeAutomaticRestores).toHaveBeenCalledOnce()
    expect(onResume).not.toHaveBeenCalled()
  })
})
