import { describe, expect, it } from 'vitest'
import { sampleOffers } from '../plan-billing-fixtures'
import {
  annualSavingsPercent,
  clampSeats,
  formatCents,
  perSeatMonthlyCents,
  periodTotalCents
} from './plans-pricing'
import { closePlansPage, getPlansPageState, openPlansPage } from './plans-page-store'

const team = sampleOffers.team

describe('plans pricing', () => {
  it('shows annual as its monthly equivalent and totals per period', () => {
    expect(perSeatMonthlyCents(team, 'month')).toBe(5000)
    expect(perSeatMonthlyCents(team, 'year')).toBe(4000)
    expect(periodTotalCents(team, 'month', 3)).toBe(15000)
    expect(periodTotalCents(team, 'year', 3)).toBe(144000)
    expect(periodTotalCents(team, 'year', 0)).toBe(48000)
  })

  it('computes the annual saving and hides it when annual is not cheaper', () => {
    expect(annualSavingsPercent(team)).toBe(20)
    expect(annualSavingsPercent({ ...team, annualPriceCentsPerSeat: 60000 })).toBeNull()
    expect(annualSavingsPercent({ ...team, monthlyPriceCentsPerSeat: null })).toBeNull()
  })

  it('falls back to labels when an older service sends no cents', () => {
    const legacy = { ...team, monthlyPriceCentsPerSeat: null, annualPriceCentsPerSeat: null }
    expect(perSeatMonthlyCents(legacy, 'month')).toBeNull()
    expect(periodTotalCents(legacy, 'year', 2)).toBeNull()
  })

  it('formats whole and fractional dollars', () => {
    expect(formatCents(5000, 'en-US')).toBe('$50')
    expect(formatCents(75, 'en-US')).toBe('$0.75')
    expect(formatCents(144000, 'en-US')).toBe('$1,440')
  })

  it('clamps seats to 1..max', () => {
    expect(clampSeats(0, 500)).toBe(1)
    expect(clampSeats(Number.NaN, 500)).toBe(1)
    expect(clampSeats(900, 500)).toBe(500)
    expect(clampSeats(3.6, 500)).toBe(4)
  })
})

describe('plans page store', () => {
  it('opens from any entry point and closes', () => {
    openPlansPage('sandbox')
    expect(getPlansPageState()).toEqual({ open: true, source: 'sandbox' })
    closePlansPage()
    expect(getPlansPageState().open).toBe(false)
  })
})
