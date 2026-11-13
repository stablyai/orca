// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaBillingEntitlement } from '../../../../../shared/orca-billing'
import { sampleTeam } from '../plan-billing-fixtures'
import { monthlyOnlyCatalogResult, sampleCatalogResult } from './plan-catalog-fixtures'
import { PlansView, shownInterval, type PlansViewProps } from './PlansView'

afterEach(cleanup)

const noPlan: OrcaBillingEntitlement = {
  ...sampleTeam,
  plan: null,
  planLabel: null,
  status: 'none',
  interval: null,
  seats: 0,
  canStartSandbox: false,
  reason: 'no_subscription'
}

function view(props: Partial<PlansViewProps>): PlansViewProps {
  return {
    result: { status: 'ok', entitlement: noPlan },
    catalog: sampleCatalogResult,
    busy: false,
    notice: null,
    seats: 4,
    onCheckout: vi.fn(),
    onManage: vi.fn(),
    onContactSales: vi.fn(),
    onRetry: vi.fn(),
    ...props
  }
}

describe("plans dialog from billing's catalog", () => {
  it("shows Stripe's prices and the catalog's features, and checks out the catalog plan", () => {
    const props = view({})
    render(<PlansView {...props} />)
    expect(screen.getByText('$50')).toBeTruthy()
    expect(
      screen.getByText('60 sandbox hours per seat each month, pooled across your team')
    ).toBeTruthy()
    expect(screen.getByText('Run sandboxes in your own cloud account')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Continue to checkout/ }))
    expect(props.onCheckout).toHaveBeenCalledWith({ planId: 'team', interval: 'month', seats: 4 })
    fireEvent.click(screen.getByRole('button', { name: /Contact sales/ }))
    expect(props.onContactSales).toHaveBeenCalledWith('https://orca.dev/enterprise')
  })

  it('gives checkout and Contact sales a "Copy link" chevron for the same order', () => {
    const checkoutLink = vi.fn(async () => 'https://checkout.stripe.com/c/pay/cs_1')
    render(<PlansView {...view({ checkoutLink })} />)
    // One chevron on the checkout button, one on Contact sales.
    expect(screen.getAllByRole('button', { name: 'More link options' })).toHaveLength(2)
  })

  it('offers only the intervals Stripe prices: no toggle with one', () => {
    render(<PlansView {...view({ catalog: monthlyOnlyCatalogResult })} />)
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.queryByText('Annual')).toBeNull()
    expect(shownInterval('year', ['month'])).toBe('month')
  })

  it('shows the skeleton while the catalog loads', () => {
    render(<PlansView {...view({ catalog: null })} />)
    expect(screen.getByRole('status', { name: 'Loading plans…' })).toBeTruthy()
  })

  it('without a catalog or offers: an error and Retry, never a price', () => {
    const props = view({
      result: { status: 'ok', entitlement: { ...noPlan, offers: null } },
      catalog: { status: 'failed', error: 'plan_catalog_503' }
    })
    render(<PlansView {...props} />)
    expect(screen.getByText('Plans didn’t load')).toBeTruthy()
    expect(screen.queryByText(/\$\d/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(props.onRetry).toHaveBeenCalled()
  })

  it('reads an older service (404) through its offers', () => {
    render(<PlansView {...view({ catalog: { status: 'unsupported' } })} />)
    expect(screen.getByText('$50')).toBeTruthy()
    expect(screen.queryByText('Everything in Team, plus:')).toBeNull()
  })
})
