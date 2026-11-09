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
    const props = { decision: null, onChange: vi.fn(), runLabel: 'Run', skipLabel: 'Skip' }
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
  })
})
