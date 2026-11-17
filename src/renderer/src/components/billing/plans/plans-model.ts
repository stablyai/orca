// What the plans dialog shows, from billing's plan catalog (GET /v1/plans): names, Stripe's prices,
// seat bounds, feature bullets, the trial's terms and each card's copy are billing's. A service from
// before the catalog (or a catalog that can't be read) falls back to the entitlement's `offers`,
// which are billing's numbers too. The desktop never supplies a price or a feature of its own.
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
  type OrcaPlanMarketing
} from '../../../../../shared/orca-billing-plans'

export type TeamPlanModel = {
  planId: string
  label: string
  currency: string
  monthlyPriceCentsPerSeat: number | null
  annualPriceCentsPerSeat: number | null
  /** Intervals on sale (priced), in display order. */
  intervals: OrcaBillingInterval[]
  /** Billing's feature bullets, in catalog order. */
  features: string[]
  marketing: OrcaPlanMarketing | null
  /** An older service's display labels, for a price it sends no cents for. */
  legacyPriceLabels: { month: string; year: string } | null
}

export type EnterprisePlanModel = {
  label: string
  priceLabel: string | null
  contactUrl: string | null
  features: string[]
  marketing: OrcaPlanMarketing | null
}

export type TrialPlanModel = { label: string; tagline: string | null; features: string[] }

type PlansModel = {
  team: TeamPlanModel
  enterprise: EnterprisePlanModel | null
  trial: TrialPlanModel | null
  /** `offers`: an older service's entitlement offers stood in for the catalog. */
  source: 'live' | 'cache' | 'offers'
}

function featureLines(features: readonly { text: string }[]): string[] {
  return features.flatMap((feature) => {
    const text = feature.text.trim()
    return text ? [text] : []
  })
}

function plansModelFromCatalog(
  catalog: OrcaPlanCatalog,
  source: 'live' | 'cache'
): PlansModel | null {
  const team = catalog.plans.find(isSelfServePlan)
  if (!team) {
    return null
  }
  const price = (interval: OrcaBillingInterval) =>
    team.prices.find((entry) => entry.interval === interval) ?? null
  const monthly = price('month')
  const annual = price('year')
  const enterprise = catalog.plans.find(isContactSalesPlan)
  const trial = catalog.plans.find((plan) => plan.kind === 'trial')
  return {
    source,
    team: {
      planId: team.id,
      label: team.name,
      currency: (monthly ?? annual)?.currency ?? 'usd',
      monthlyPriceCentsPerSeat: monthly?.unitAmountCents ?? null,
      annualPriceCentsPerSeat: annual?.unitAmountCents ?? null,
      intervals: [monthly, annual].flatMap((entry) => (entry ? [entry.interval] : [])),
      features: featureLines(team.features),
      marketing: team.marketing,
      legacyPriceLabels: null
    },
    enterprise: enterprise
      ? {
          label: enterprise.name,
          priceLabel: enterprise.priceLabel,
          contactUrl: enterprise.contactUrl,
          features: featureLines(enterprise.features),
          marketing: enterprise.marketing
        }
      : null,
    trial: trial
      ? {
          label: trial.name,
          tagline: trial.marketing?.tagline ?? null,
          features: featureLines(trial.features)
        }
      : null
  }
}

/** An older billing service (no GET /v1/plans): its entitlement offers. No feature bullets. */
function plansModelFromOffers(offers: OrcaBillingOffers): PlansModel {
  const team = offers.team
  const intervals: OrcaBillingInterval[] = []
  if (team.monthlyPriceCentsPerSeat !== null || team.monthlyPriceLabel) {
    intervals.push('month')
  }
  if (team.annualPriceCentsPerSeat !== null || team.annualPriceLabel) {
    intervals.push('year')
  }
  return {
    source: 'offers',
    team: {
      planId: 'team',
      label: team.label,
      currency: 'usd',
      monthlyPriceCentsPerSeat: team.monthlyPriceCentsPerSeat,
      annualPriceCentsPerSeat: team.annualPriceCentsPerSeat,
      intervals,
      features: [],
      marketing: null,
      legacyPriceLabels: { month: team.monthlyPriceLabel, year: team.annualPriceLabel }
    },
    enterprise: offers.enterprise.label
      ? {
          label: offers.enterprise.label,
          priceLabel: offers.enterprise.priceLabel || null,
          contactUrl: offers.enterprise.contactUrl || null,
          features: [],
          marketing: null
        }
      : null,
    trial: null
  }
}

type PlansModelState =
  | { state: 'loading' }
  | { state: 'ready'; model: PlansModel }
  /** Nothing from billing to show: the dialog still offers the console, never a guessed price. */
  | { state: 'unavailable' }

/** Catalog first; the entitlement's offers only when the catalog can't be had. */
export function resolvePlansModel(
  catalog: OrcaPlanCatalogResult | null,
  billing: OrcaBillingStatusResult | null
): PlansModelState {
  if (catalog?.status === 'ok') {
    const model = plansModelFromCatalog(catalog.catalog, catalog.source)
    if (model) {
      return { state: 'ready', model }
    }
  }
  if (catalog === null) {
    return { state: 'loading' }
  }
  const offers = billing?.status === 'ok' ? billing.entitlement.offers : null
  if (offers) {
    return { state: 'ready', model: plansModelFromOffers(offers) }
  }
  // Billing may still answer with offers; wait for it rather than flash "unavailable".
  return billing === null ? { state: 'loading' } : { state: 'unavailable' }
}
