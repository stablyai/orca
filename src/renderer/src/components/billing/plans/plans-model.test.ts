import { describe, expect, it } from 'vitest'
import { sampleOffers, sampleTeam } from '../plan-billing-fixtures'
import {
  monthlyOnlyCatalogResult,
  sampleCatalog,
  sampleCatalogResult
} from './plan-catalog-fixtures'
import { plansModelFromCatalog, plansModelFromOffers, resolvePlansModel } from './plans-model'

const billing = { status: 'ok' as const, entitlement: sampleTeam }

describe('plans model', () => {
  it('takes prices, features, seats and Enterprise from the catalog', () => {
    const model = plansModelFromCatalog(sampleCatalog)
    expect(model?.source).toBe('catalog')
    expect(model?.team).toMatchObject({
      planId: 'team',
      label: 'Team',
      currency: 'usd',
      monthlyPriceCentsPerSeat: 5000,
      annualPriceCentsPerSeat: 48000,
      intervals: ['month', 'year'],
      seats: { min: 1, max: 500 },
      checkoutAvailable: true
    })
    expect(model?.team.features.map((feature) => feature.id)).toEqual([
      'included_hours_per_seat',
      'agents_keep_running',
      'idle_sleep',
      'overage_optional'
    ])
    expect(model?.enterprise?.features.map((feature) => feature.id)).toEqual([
      'byoc',
      'sso_scim',
      'egress_controls',
      'custom_limits'
    ])
  })

  it('sells only the intervals Stripe has a price for', () => {
    const model =
      monthlyOnlyCatalogResult.status === 'ok'
        ? plansModelFromCatalog(monthlyOnlyCatalogResult.catalog)
        : null
    expect(model?.team).toMatchObject({ intervals: ['month'], annualPriceCentsPerSeat: null })
  })

  it('reads an older service through its offers (billing numbers, no Enterprise bullets)', () => {
    const model = plansModelFromOffers(sampleOffers)
    expect(model.source).toBe('offers')
    expect(model.team).toMatchObject({
      planId: 'team',
      monthlyPriceCentsPerSeat: 5000,
      intervals: ['month', 'year']
    })
    expect(model.team.features[0]).toEqual({
      id: 'included_hours_per_seat',
      params: { hours: 60 },
      text: ''
    })
    expect(model.enterprise?.features).toEqual([])
  })

  it('resolves loading, catalog, the 404 fallback and failure', () => {
    expect(resolvePlansModel(null, billing)).toEqual({ state: 'loading' })
    expect(resolvePlansModel(sampleCatalogResult, null)).toMatchObject({
      state: 'ready',
      model: { source: 'catalog' }
    })
    expect(resolvePlansModel({ status: 'unsupported' }, billing)).toMatchObject({
      state: 'ready',
      model: { source: 'offers' }
    })
    expect(resolvePlansModel({ status: 'failed', error: 'x' }, billing)).toMatchObject({
      state: 'ready',
      model: { source: 'offers' }
    })
    expect(
      resolvePlansModel(
        { status: 'failed', error: 'x' },
        { status: 'ok', entitlement: { ...sampleTeam, offers: null } }
      )
    ).toEqual({ state: 'failed' })
    expect(resolvePlansModel({ status: 'unsupported' }, { status: 'failed', error: 'x' })).toEqual({
      state: 'failed'
    })
  })
})
