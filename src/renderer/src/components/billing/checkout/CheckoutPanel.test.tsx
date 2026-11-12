// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sampleOffers } from '../plan-billing-fixtures'
import { CheckoutPanel } from './CheckoutPanel'

afterEach(cleanup)

const order = { planId: 'team', interval: 'month' as const, seats: 3 }

describe('checkout when billing cannot sell the plan (409 plan_unavailable)', () => {
  it('says so, retries, and offers a way to contact us', () => {
    const onReopen = vi.fn()
    const onContact = vi.fn()
    render(
      <CheckoutPanel
        phase={{ kind: 'open-failed', order, result: { status: 'plan-unavailable' } }}
        team={sampleOffers.team}
        now={Date.UTC(2026, 10, 12)}
        onReopen={onReopen}
        onKeepWaiting={() => {}}
        onBack={() => {}}
        contactUrl="https://onorca.dev/contact-sales"
        onContact={onContact}
      />
    )
    expect(
      screen.getByRole('heading', { name: 'This plan isn’t available right now' })
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }))
    expect(onReopen).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Contact us/ }))
    expect(onContact).toHaveBeenCalledWith('https://onorca.dev/contact-sales')
  })

  it('a generic failure keeps its own title and no contact action', () => {
    render(
      <CheckoutPanel
        phase={{ kind: 'open-failed', order, result: { status: 'failed', error: 'timeout' } }}
        team={sampleOffers.team}
        now={0}
        onReopen={() => {}}
        onKeepWaiting={() => {}}
        onBack={() => {}}
        contactUrl="https://onorca.dev/contact-sales"
        onContact={() => {}}
      />
    )
    expect(screen.getByRole('heading', { name: 'Checkout didn’t open' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Contact us/ })).toBeNull()
  })
})
