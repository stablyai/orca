// What the plans dialog renders, from billing's plan catalog (GET /v1/plans). Every price, feature
// and bound here is billing's: prices are Stripe's, features and seat bounds the billing catalog's.
// A billing service from before the catalog (404) is read through its entitlement `offers`, which
// are billing's numbers too; the desktop never supplies a price or a feature of its own.
import type {
  OrcaBillingInterval,
  OrcaBillingOffers,
  OrcaBillingStatusResult
} from '../../../../../shared/orca-billing'
import {
  isContactSalesPlan,
  isSelfServePlan,
  type OrcaPlanCatalog,
  type OrcaPlanCatalogResult,
  type OrcaPlanFeature
} from '../../../../../shared/orca-billing-plans'
import { ORCA_BILLING_MAX_SEATS } from '../../../../../shared/orca-billing'

export type TeamPlanModel = {
  /** Sent to Checkout; billing resolves the Stripe price for it. */
  planId: string
  label: string
  currency: string
  monthlyPriceCentsPerSeat: number | null
  annualPriceCentsPerSeat: number | null
  /** Intervals on sale (priced), in display order. */
  intervals: OrcaBillingInterval[]
  seats: { min: number; max: number }
  features: OrcaPlanFeature[]
  includedHoursPerSeat: number | null
  overage: { centsPerHour: number; defaultSpendCapCents: number } | null
  idleSleepMinutes: number | null
  checkoutAvailable: boolean
  /** An older service's display labels, for a price it sends no cents for. */
  legacyPriceLabels: { month: string; year: string } | null
  /** The plan's own "Contact us" (https), when the catalog names one. */
  supportUrl: string | null
}

export type EnterprisePlanModel = {
  label: string
  priceLabel: string | null
  contactUrl: string | null
  features: OrcaPlanFeature[]
}

export type PlansModel = {
  team: TeamPlanModel
  enterprise: EnterprisePlanModel | null
  source: 'catalog' | 'offers'
}

export function plansModelFromCatalog(catalog: OrcaPlanCatalog): PlansModel | null {
  const team = catalog.plans.find(isSelfServePlan)
  if (!team) {
    return null
  }
  const price = (interval: OrcaBillingInterval) =>
    team.prices.find((entry) => entry.interval === interval) ?? null
  const monthly = price('month')
  const annual = price('year')
  const enterprise = catalog.plans.find(isContactSalesPlan)
  return {
    source: 'catalog',
    team: {
      planId: team.id,
      label: team.name,
      currency: (monthly ?? annual)?.currency ?? 'usd',
      monthlyPriceCentsPerSeat: monthly?.unitAmountCents ?? null,
      annualPriceCentsPerSeat: annual?.unitAmountCents ?? null,
      intervals: [monthly, annual].flatMap((entry) => (entry ? [entry.interval] : [])),
      seats: team.seats,
      features: team.features,
      includedHoursPerSeat: team.includedHoursPerSeat,
      overage: team.overage,
      idleSleepMinutes: null,
      checkoutAvailable: team.checkoutAvailable,
      legacyPriceLabels: null,
      supportUrl: team.supportUrl
    },
    enterprise: enterprise
      ? {
          label: enterprise.name,
          priceLabel: enterprise.priceLabel,
          contactUrl: enterprise.contactUrl,
          features: enterprise.features
        }
      : null
  }
}

/**
 * An older billing service (no GET /v1/plans): its entitlement offers, as the same model. The
 * feature ids below are the catalog's own; their numbers are the offers' (billing's).
 */
export function plansModelFromOffers(offers: OrcaBillingOffers): PlansModel {
  const team = offers.team
  const intervals: OrcaBillingInterval[] = []
  if (team.monthlyPriceCentsPerSeat !== null) {
    intervals.push('month')
  }
  if (team.annualPriceCentsPerSeat !== null) {
    intervals.push('year')
  }
  const feature = (id: string, params: Record<string, number> = {}): OrcaPlanFeature => ({
    id,
    params,
    text: ''
  })
  return {
    source: 'offers',
    team: {
      planId: 'team',
      label: team.label,
      currency: 'usd',
      monthlyPriceCentsPerSeat: team.monthlyPriceCentsPerSeat,
      annualPriceCentsPerSeat: team.annualPriceCentsPerSeat,
      // Services without per-seat cents still sell both intervals by their price labels.
      intervals: intervals.length > 0 ? intervals : ['month', 'year'],
      seats: { min: 1, max: ORCA_BILLING_MAX_SEATS },
      features: [
        feature('included_hours_per_seat', { hours: team.includedHoursPerSeat }),
        feature('idle_sleep', { minutes: team.idleSleepMinutes }),
        feature('overage_optional')
      ],
      includedHoursPerSeat: team.includedHoursPerSeat,
      overage: {
        centsPerHour: team.overageCentsPerHour,
        defaultSpendCapCents: team.defaultSpendCapCents
      },
      idleSleepMinutes: team.idleSleepMinutes,
      checkoutAvailable: true,
      legacyPriceLabels: { month: team.monthlyPriceLabel, year: team.annualPriceLabel },
      supportUrl: null
    },
    enterprise: {
      label: offers.enterprise.label,
      priceLabel: offers.enterprise.priceLabel,
      contactUrl: offers.enterprise.contactUrl,
      // Older services name no Enterprise features; the card leads with "Contact sales".
      features: []
    }
  }
}

export type PlansModelState =
  | { state: 'loading' }
  | { state: 'ready'; model: PlansModel }
  | { state: 'failed' }

/**
 * Catalog first. The entitlement's offers stand in only when the service predates the catalog,
 * or the catalog couldn't be read (they are billing's numbers as well). Nothing usable: failed.
 */
export function resolvePlansModel(
  catalog: OrcaPlanCatalogResult | null,
  billing: OrcaBillingStatusResult | null
): PlansModelState {
  if (catalog?.status === 'ok') {
    const model = plansModelFromCatalog(catalog.catalog)
    if (model) {
      return { state: 'ready', model }
    }
  }
  const offers = billing?.status === 'ok' ? billing.entitlement.offers : null
  if (catalog === null || billing === null) {
    return { state: 'loading' }
  }
  return offers ? { state: 'ready', model: plansModelFromOffers(offers) } : { state: 'failed' }
}

/** Where "Contact us" goes when billing can't sell the plan: its support URL, else Enterprise's contact. */
export function planContactUrl(model: PlansModel): string | null {
  return model.team.supportUrl ?? model.enterprise?.contactUrl ?? null
}
