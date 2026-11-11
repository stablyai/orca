// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceSetupChoice } from './WorkspaceSetupChoice'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('WorkspaceSetupChoice', () => {
  it('brings the choice into view and focuses it on each reveal request', () => {
    vi.useFakeTimers()
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    const onRevealed = vi.fn()
    const props = {
      decision: null,
      onChange: vi.fn(),
      runLabel: 'Run',
      skipLabel: 'Skip',
      onRevealed
    }
    const { rerender } = render(<WorkspaceSetupChoice {...props} revealRequest={0} />)
    vi.runAllTimers()
    expect(scrollIntoView).not.toHaveBeenCalled()

    // A second request matters too: Advanced may already be open from the first.
    for (const revealRequest of [1, 2]) {
      rerender(<WorkspaceSetupChoice {...props} revealRequest={revealRequest} />)
      vi.runAllTimers()
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Run' }))
    }
    expect(scrollIntoView).toHaveBeenCalledTimes(2)
    // Each handled request is cleared so a remount after a project switch cannot replay it.
    expect(onRevealed).toHaveBeenCalledTimes(2)
  })

  it('does not move focus onto Run when the user chose before the reveal fired', () => {
    vi.useFakeTimers()
    Element.prototype.scrollIntoView = vi.fn()
    const onRevealed = vi.fn()
    const props = { onChange: vi.fn(), runLabel: 'Run', skipLabel: 'Skip', onRevealed }
    const { rerender } = render(
      <WorkspaceSetupChoice {...props} decision={null} revealRequest={1} />
    )
    rerender(<WorkspaceSetupChoice {...props} decision="skip" revealRequest={1} />)
    vi.runAllTimers()

    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Run' }))
    expect(onRevealed).toHaveBeenCalledTimes(1)
  })
})
