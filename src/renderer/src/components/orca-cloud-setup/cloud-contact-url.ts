import type { OrcaPlanCatalogResult } from '../../../../shared/orca-billing-plans'

/**
 * Where "Contact us" goes from Orca Cloud setup: the billing catalog's contact target (its
 * contact-sales plan's URL, as the plans dialog uses since ENTITLEMENTS-D). Null hides the button;
 * there is no hard-coded address.
 */
export function cloudContactUrl(result: OrcaPlanCatalogResult | null): string | null {
  if (result?.status !== 'ok') {
    return null
  }
  for (const plan of result.catalog.plans) {
    if (
      plan.kind === 'contact_sales' &&
      'contactUrl' in plan &&
      typeof plan.contactUrl === 'string'
    ) {
      return plan.contactUrl
    }
  }
  return null
}
