// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  OrcaBillingOverageResult,
  OrcaBillingStatusResult
} from '../../../../shared/orca-billing'
import { sampleTeam } from '../billing/plan-billing-fixtures'
import { VmBuildBillingBlocker, type BillingBlockKind } from './VmBuildBillingBlocker'

const setOverage =
  vi.fn<(args: { enabled: boolean; spendCapCents?: number }) => Promise<OrcaBillingOverageResult>>()
const billingStatus = vi.fn<() => Promise<OrcaBillingStatusResult>>()
vi.mock('../billing/plans/plans-page-store', () => ({ openPlansPage: vi.fn() }))
vi.mock('@/lib/orca-cloud-after-checkout', () => ({ requestOrcaCloudAfterCheckout: vi.fn() }))

const openPortal = vi.fn(() => Promise.resolve({ status: 'opened' as const }))

beforeEach(() => {
  setOverage.mockReset()
  billingStatus.mockReset()
  openPortal.mockClear()
  Object.assign(window, {
    api: {
      orcaProfiles: {
        billingSetOverage: setOverage,
        billingStatus,
        billingOpenPortal: openPortal
      }
    }
  })
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
    reason?: string | null
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
      creationId="c1"
      canManageBilling={canManageBilling}
      entitlement={{
        ...sampleTeam,
        offers: offers ? sampleTeam.offers : null,
        overage: { ...sampleTeam.overage, spendCapCents: capCents },
        ...(reason !== undefined ? { reason: reason as never } : {})
      }}
      onContinue={onContinue}
      onBackToDraft={onBackToDraft}
    />
  )
  return { onContinue, onBackToDraft }
}

describe('billing blocker on the creating sheet (JA-21)', () => {
  it('out of hours: Turn on with a $25 cap saves overage and continues the create', async () => {
    setOverage.mockResolvedValue({ status: 'ok', entitlement: sampleTeam })
    const { onContinue } = renderBlocker('hoursUsed')
    expect(screen.getByRole('heading', { name: 'Out of sandbox hours' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Turn on with a $25 cap' }))
    await waitFor(() => expect(onContinue).toHaveBeenCalledOnce())
    expect(setOverage).toHaveBeenCalledWith({
      enabled: true,
      spendCapCents: 2500
    })
  })

  it("without billing's default cap: plain Turn on overage, and billing applies its default", async () => {
    setOverage.mockResolvedValue({ status: 'ok', entitlement: sampleTeam })
    const { onContinue } = renderBlocker('hoursUsed', { offers: false })
    fireEvent.click(screen.getByRole('button', { name: 'Turn on overage' }))
    await waitFor(() => expect(onContinue).toHaveBeenCalledOnce())
    expect(setOverage).toHaveBeenCalledWith({ enabled: true })
  })

  it('a failed save shows inline and does not continue', async () => {
    setOverage.mockResolvedValue({ status: 'failed', error: 'boom' })
    const { onContinue } = renderBlocker('hoursUsed')
    fireEvent.click(screen.getByRole('button', { name: 'Turn on with a $25 cap' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).not.toBe(''))
    expect(onContinue).not.toHaveBeenCalled()
  })

  it('spend cap reached: the field starts at the cap plus $25 and saving continues', async () => {
    setOverage.mockResolvedValue({ status: 'ok', entitlement: sampleTeam })
    const { onContinue } = renderBlocker('spendCap', { capCents: 4000 })
    const field = screen.getByLabelText('Monthly spend cap')
    expect(field).toHaveProperty('value', '65')
    fireEvent.change(field, { target: { value: '100' } })
    fireEvent.click(screen.getByRole('button', { name: 'Raise spend cap and continue' }))
    await waitFor(() => expect(onContinue).toHaveBeenCalledOnce())
    expect(setOverage).toHaveBeenCalledWith({
      enabled: true,
      spendCapCents: 10_000
    })
  })

  it('payment failed: Update payment method opens billing, and returning re-checks once', async () => {
    billingStatus.mockResolvedValue({
      status: 'ok',
      entitlement: { ...sampleTeam, canStartSandbox: true }
    })
    const { onContinue } = renderBlocker('payment')
    fireEvent.click(screen.getByRole('button', { name: 'Update payment method' }))
    expect(openPortal).toHaveBeenCalledOnce()
    expect(screen.getByText('Finish in your browser.')).toBeTruthy()
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(onContinue).toHaveBeenCalledOnce())
    expect(billingStatus).toHaveBeenCalledOnce()
  })

  it('still blocked after the browser: stays on the card with Check again', async () => {
    billingStatus.mockResolvedValue({
      status: 'ok',
      entitlement: { ...sampleTeam, canStartSandbox: false }
    })
    const { onContinue } = renderBlocker('payment')
    fireEvent.click(screen.getByRole('button', { name: 'Update payment method' }))
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() =>
      expect(
        screen.getByText('Not updated yet. Finish in your browser, then check again.')
      ).toBeTruthy()
    )
    expect(onContinue).not.toHaveBeenCalled()
  })

  it('no plan: Compare plans opens Plans and continues this create once paid', async () => {
    const { openPlansPage } = await import('../billing/plans/plans-page-store')
    const { requestOrcaCloudAfterCheckout } = await import('@/lib/orca-cloud-after-checkout')
    renderBlocker('plan')
    expect(screen.getByRole('heading', { name: 'Choose a plan' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Compare plans' }))
    expect(requestOrcaCloudAfterCheckout).toHaveBeenCalledWith({ kind: 'retry', creationId: 'c1' })
    expect(openPlansPage).toHaveBeenCalledWith('sandbox')
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
    expect(setOverage).not.toHaveBeenCalled()
    expect(onContinue).not.toHaveBeenCalled()
  })
})
