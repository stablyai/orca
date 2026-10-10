// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { DashboardHostBadge } from './DashboardHostBadge'

afterEach(cleanup)

describe('DashboardHostBadge', () => {
  it('names a saved SSH host in its focusable tooltip', async () => {
    render(
      <TooltipProvider>
        <DashboardHostBadge
          hostKind="ssh"
          executionHostId="ssh:opaque-target"
          hostLabel="openclaw"
          keyboardFocusable
        />
      </TooltipProvider>
    )

    const badge = screen.getByLabelText('SSH host · openclaw')
    expect(badge).toHaveAttribute('data-dashboard-host-badge', 'ssh')
    expect(badge.querySelector('.lucide-server')).toBeInTheDocument()

    fireEvent.focus(badge)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('SSH host · openclaw')
  })

  it('distinguishes paired Orca hosts and omits local hosts', () => {
    const { rerender } = render(
      <TooltipProvider>
        <DashboardHostBadge
          hostKind="remote"
          executionHostId="runtime:server-1"
          hostLabel="Build Mac"
        />
      </TooltipProvider>
    )

    const badge = screen.getByLabelText('Remote Orca host · Build Mac')
    expect(badge).toHaveAttribute('data-dashboard-host-badge', 'remote')
    expect(badge.querySelector('.lucide-server')).toBeInTheDocument()

    rerender(
      <TooltipProvider>
        <DashboardHostBadge hostKind="local" executionHostId="local" />
      </TooltipProvider>
    )
    expect(screen.queryByLabelText(/host/i)).not.toBeInTheDocument()
  })
})
