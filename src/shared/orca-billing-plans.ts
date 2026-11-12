// The Orca Cloud plan catalog as the desktop sees it: billing's public GET /v1/plans
// (cloud/apps/billing src/plans-api.ts). Prices are Stripe's, entitlements and features are the
// billing catalog's; the desktop renders them and never holds a price or feature of its own.
import type { OrcaBillingInterval } from './orca-billing'

export type OrcaPlanFeature = {
  /** Stable id the desktop localizes (plan-feature-copy.ts); `text` is the English fallback. */
  id: string
  params: Record<string, string | number>
  text: string
}

export type OrcaPlanPrice = {
  interval: OrcaBillingInterval
  unitAmountCents: number
  currency: string
}

export type OrcaSelfServePlan = {
  kind: 'self_serve'
  id: string
  name: string
  version: number
  features: OrcaPlanFeature[]
  /** Where "Contact us" goes for this plan (https), or null: fall back to the Enterprise contact. */
  supportUrl: string | null
  /** Only intervals Stripe has a price for; empty when none is on sale. */
  prices: OrcaPlanPrice[]
  overage: {
    centsPerHour: number
    defaultSpendCapCents: number
    maxSpendCapCents: number
  } | null
  seats: { min: number; max: number }
  /** Hours per seat per month, when the plan grants them per seat. */
  includedHoursPerSeat: number | null
  checkoutAvailable: boolean
}

export type OrcaContactSalesPlan = {
  kind: 'contact_sales'
  id: string
  name: string
  version: number
  features: OrcaPlanFeature[]
  /** Where "Contact us" goes for this plan (https), or null: fall back to the Enterprise contact. */
  supportUrl: string | null
  contactUrl: string | null
  priceLabel: string | null
}

/** Trial, free, or a kind a newer service added: listed, not sold here. */
export type OrcaOtherPlan = {
  kind: string
  id: string
  name: string
  version: number
  features: OrcaPlanFeature[]
  /** Where "Contact us" goes for this plan (https), or null: fall back to the Enterprise contact. */
  supportUrl: string | null
}

export type OrcaPlanCatalogPlan = OrcaSelfServePlan | OrcaContactSalesPlan | OrcaOtherPlan

export type OrcaPlanCatalog = {
  catalogVersion: string
  plans: OrcaPlanCatalogPlan[]
}

export type OrcaPlanCatalogResult =
  /** `cache`: the last good copy (offline, under a week old). */
  | { status: 'ok'; catalog: OrcaPlanCatalog; source: 'live' | 'cache'; fetchedAt: number }
  /** The billing service predates GET /v1/plans (404): use the entitlement's offers instead. */
  | { status: 'unsupported' }
  | { status: 'unconfigured' }
  | { status: 'failed'; error: string }

export function isSelfServePlan(plan: OrcaPlanCatalogPlan): plan is OrcaSelfServePlan {
  return plan.kind === 'self_serve'
}

export function isContactSalesPlan(plan: OrcaPlanCatalogPlan): plan is OrcaContactSalesPlan {
  return plan.kind === 'contact_sales'
}
