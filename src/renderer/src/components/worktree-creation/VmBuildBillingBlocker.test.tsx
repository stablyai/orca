// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  OrcaBillingDenyReason,
  OrcaBillingStatusResult
} from '../../../../shared/orca-billing'
import { sampleTeam } from '../billing/plan-billing-fixtures'
import { VmBuildBillingBlocker, type BillingBlockKind } from './VmBuildBillingBlocker'

const billingStatus = vi.fn<() => Promise<OrcaBillingStatusResult>>()
const openCloudConsole = vi.fn((_section: string) => Promise.resolve())
vi.mock('@/lib/orca-cloud/open-cloud-console', () => ({
  openCloudConsole: (section: string) => openCloudConsole(section)
}))
vi.mock('@/components/billing/plans/plans-dialog-store', () => ({ openPlansDialog: vi.fn() }))

beforeEach(() => {
  billingStatus.mockReset()
  openCloudConsole.mockClear()
  Object.assign(window, { api: { orcaProfiles: { billingStatus } } })
})

afterEach(() => {
  cleanup()
})

function renderBlocker(
  kind: BillingBlockKind,
  {
    canManageBilling = true,
    capCents = 2500,
    offers = true,
    reason
  }: {
    canManageBilling?: boolean
    capCents?: number
    offers?: boolean
    reason?: OrcaBillingDenyReason | null
  } = {}
): {
  onContinue: ReturnType<typeof vi.fn>
  onBackToDraft: ReturnType<typeof vi.fn>
} {
  const onContinue = vi.fn()
  const onBackToDraft = vi.fn()
  render(
    <VmBuildBillingBlocker
      kind={kind}
      canManageBilling={canManageBilling}
      entitlement={{
        ...sampleTeam,
        offers: offers ? sampleTeam.offers : null,
        overage: { ...sampleTeam.overage, spendCapCents: capCents },
        ...(reason !== undefined ? { reason } : {})
      }}
      onContinue={onContinue}
      onBackToDraft={onBackToDraft}
    />
  )
  return { onContinue, onBackToDraft }
}

describe('billing blocker on the creating sheet (JA-21)', () => {
  it.each([
    ['hoursUsed', 'Out of sandbox hours', 'Turn on in browser'],
    ['spendCap', 'Spend cap reached', 'Raise in browser'],
    ['payment', 'Payment failed', 'Update in browser']
  ] as const)(
    '%s: the fix opens billing in the browser, and returning re-checks and continues',
    async (kind, title, button) => {
      billingStatus.mockResolvedValue({
        status: 'ok',
        entitlement: { ...sampleTeam, canStartSandbox: true }
      })
      const { onContinue } = renderBlocker(kind)
      expect(screen.getByRole('heading', { name: title })).toBeTruthy()
      // Nothing changes billing from the desktop: no form, no in-app save.
      expect(screen.queryByLabelText('Monthly spend cap')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: button }))
      expect(openCloudConsole).toHaveBeenCalledWith('billing')
      expect(screen.getByText('Finish in your browser.')).toBeTruthy()
      expect(onContinue).not.toHaveBeenCalled()
      act(() => {
        window.dispatchEvent(new Event('focus'))
      })
      await waitFor(() => expect(onContinue).toHaveBeenCalledOnce())
      expect(billingStatus).toHaveBeenCalledOnce()
    }
  )

  it('still blocked after the browser: stays on the card with Check again', async () => {
    billingStatus.mockResolvedValue({
      status: 'ok',
      entitlement: { ...sampleTeam, canStartSandbox: false }
    })
    const { onContinue } = renderBlocker('payment')
    fireEvent.click(screen.getByRole('button', { name: 'Update in browser' }))
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() =>
      expect(
        screen.getByText('Not updated yet. Finish in your browser, then check again.')
      ).toBeTruthy()
    )
    expect(onContinue).not.toHaveBeenCalled()
  })

  it('no plan: Compare plans opens the plans dialog, and returning re-checks once', async () => {
    const { openPlansDialog } = await import('@/components/billing/plans/plans-dialog-store')
    billingStatus.mockResolvedValue({
      status: 'ok',
      entitlement: { ...sampleTeam, canStartSandbox: true }
    })
    const { onContinue } = renderBlocker('plan')
    expect(screen.getByRole('heading', { name: 'Choose a plan' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Compare plans' }))
    expect(openPlansDialog).toHaveBeenCalledOnce()
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(onContinue).toHaveBeenCalledOnce())
  })

  it.each([
    ['subscription_inactive', true, 'Your team’s plan has ended.'],
    ['trial_used_up', true, 'Your trial is used up.'],
    ['trial_used_up', false, 'Your team’s trial is used up.'],
    ['no_subscription', true, 'Your team doesn’t have a plan yet.'],
    ['trial_unavailable', true, 'This account or team already used its trial.'],
    [null, true, 'Your team needs a plan to use Orca Cloud.']
  ] as const)(
    'no plan (%s, admin=%s): only a plan that existed has "ended" (EP-11)',
    (reason, admin, body) => {
      renderBlocker('plan', { reason, canManageBilling: admin })
      expect(screen.getByText(body)).toBeTruthy()
      if (reason !== 'subscription_inactive') {
        expect(screen.queryByText('Your team’s plan has ended.')).toBeNull()
      }
    }
  )

  it.each([
    ['hoursUsed', 'Ask an owner or admin to add hours.'],
    ['spendCap', 'Ask an owner or admin to raise the spend cap.'],
    ['payment', 'Ask an owner or admin to update the payment method.'],
    ['plan', 'Ask an owner or admin to choose a plan.']
  ] as const)('member, %s: says who can fix it and offers only Back to draft', (kind, ask) => {
    renderBlocker(kind, { canManageBilling: false })
    expect(screen.getByText(ask)).toBeTruthy()
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Back to draft'
    ])
  })

  it('Back to draft hands the draft back without saving anything', () => {
    const { onBackToDraft, onContinue } = renderBlocker('hoursUsed')
    fireEvent.click(screen.getByRole('button', { name: 'Back to draft' }))
    expect(onBackToDraft).toHaveBeenCalledOnce()
    expect(openCloudConsole).not.toHaveBeenCalled()
    expect(onContinue).not.toHaveBeenCalled()
  })
})
