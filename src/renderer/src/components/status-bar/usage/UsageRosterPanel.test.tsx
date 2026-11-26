// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '../../ui/dropdown-menu'
import { TooltipProvider } from '../../ui/tooltip'
import { UsageRosterPanel } from './UsageRosterPanel'

vi.mock('./usage-meter', () => ({
  UsageDisplayToggle: () => null,
  UsageBar: () => null,
  UsageValue: () => null
}))
afterEach(cleanup)

it('does not mount account drill-ins while the owner cannot provide account actions', () => {
  function Panel({ available }: { available: boolean }) {
    return (
      <TooltipProvider>
        <DropdownMenu open>
          <DropdownMenuTrigger>Usage</DropdownMenuTrigger>
          <DropdownMenuContent>
            <UsageRosterPanel
              providers={[
                {
                  provider: 'claude',
                  status: 'error',
                  session: null,
                  weekly: null,
                  error: 'Unavailable',
                  updatedAt: 1,
                  usageMetadata: { unverifiableOwner: true }
                }
              ]}
              display="used"
              statusBarUsageMode="verbose"
              actionsAvailable={available}
              isRefreshing={false}
              onStatusBarUsageModeChange={() => {}}
              onRefresh={() => {}}
              onOpenProvider={() => {}}
              onSignIn={() => {}}
              canSignIn={() => false}
              onManageAccounts={() => {}}
              onUsageDetails={() => {}}
              renderRow={() => <button>Host account drill-in</button>}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </TooltipProvider>
    )
  }
  const { rerender } = render(<Panel available={false} />)
  expect(screen.queryByRole('button', { name: 'Host account drill-in' })).toBeNull()
  rerender(<Panel available />)
  expect(screen.getByRole('button', { name: 'Host account drill-in' })).toBeTruthy()
})
