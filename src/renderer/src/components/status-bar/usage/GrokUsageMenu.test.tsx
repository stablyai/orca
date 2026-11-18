// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { GrokUsageMenu } from './GrokUsageMenu'

const mocks = vi.hoisted(() => ({ openAppHttpLink: vi.fn() }))

vi.mock('@/lib/browser/navigation/app-http-link-open', () => ({
  openAppHttpLink: mocks.openAppHttpLink
}))
vi.mock('../../../store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ usagePercentageDisplay: 'used', recordFeatureInteraction: vi.fn() })
}))

const grok: ProviderRateLimits = {
  provider: 'grok',
  session: null,
  weekly: { usedPercent: 92, windowMinutes: 10080, resetsAt: null, resetDescription: null },
  updatedAt: 1,
  error: null,
  status: 'ok'
}

afterEach(() => {
  cleanup()
  mocks.openAppHttpLink.mockReset()
})

describe('GrokUsageMenu', () => {
  it('opens Grok billing once in the system browser from the keyboard and closes the menu', () => {
    const onOpenChange = vi.fn()
    render(
      <DropdownMenu defaultOpen modal={false} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger>Usage</DropdownMenuTrigger>
        <DropdownMenuContent>
          <GrokUsageMenu grok={grok} compact={false} triggerContent="Grok" />
        </DropdownMenuContent>
      </DropdownMenu>
    )
    const subTrigger = screen.getByRole('menuitem', { name: 'Grok' })
    subTrigger.focus()
    fireEvent.keyDown(subTrigger, { key: 'ArrowRight' })

    const item = screen.getByRole('menuitem', { name: 'Open Grok billing' })
    item.focus()
    fireEvent.keyDown(item, { key: 'Enter' })

    expect(mocks.openAppHttpLink).toHaveBeenCalledTimes(1)
    expect(mocks.openAppHttpLink).toHaveBeenCalledWith('https://grok.com/dashboard/billing', {
      destination: 'system'
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
