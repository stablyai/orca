// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WslHostMark } from './WslHostMark'

afterEach(cleanup)

describe('WslHostMark', () => {
  it('is a penguin named for screen readers, with the full host in its tooltip', async () => {
    const view = render(
      <TooltipProvider delayDuration={0}>
        <WslHostMark distro="orca-demo" />
      </TooltipProvider>
    )
    const mark = view.getByRole('img', {
      name: 'Runs on WSL: orca-demo (Linux)'
    })
    expect(mark.querySelector('svg')).toBeTruthy()
    expect(view.queryByText('orca-demo (WSL)')).toBeNull()
    // Keyboard users reach it with Tab; focus alone opens the tooltip.
    expect(mark.tabIndex).toBe(0)
    act(() => mark.focus())
    expect(document.activeElement).toBe(mark)
    await vi.waitFor(() =>
      expect(document.querySelector('[data-slot="tooltip-content"]')?.textContent).toContain(
        'Runs on WSL: orca-demo (Linux)'
      )
    )
  })
})
