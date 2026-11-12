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
  { canManageBilling = true, capCents = 2500 } = {}
): {
  onContinue: ReturnType<typeof vi.fn>
  onBackToDraft: ReturnType<typeof vi.fn>
  onComparePlans: ReturnType<typeof vi.fn>
} {
  const onContinue = vi.fn()
  const onBackToDraft = vi.fn()
  const onComparePlans = vi.fn()
  render(
    <VmBuildBillingBlocker
      kind={kind}
      canManageBilling={canManageBilling}
      entitlement={{
        ...sampleTeam,
        overage: { ...sampleTeam.overage, spendCapCents: capCents }
      }}
      onContinue={onContinue}
      onComparePlans={onComparePlans}
      onBackToDraft={onBackToDraft}
    />
  )
  return { onContinue, onBackToDraft, onComparePlans }
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

  it('no plan: Compare plans is the way forward', () => {
    const { onComparePlans } = renderBlocker('plan')
    expect(screen.getByRole('heading', { name: 'Choose a plan' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Compare plans' }))
    expect(onComparePlans).toHaveBeenCalledOnce()
  })

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
