// A plan feature from billing's catalog as one line of copy. Feature ids the desktop knows are
// localized here, filled with the catalog's numbers; an id it doesn't know (a newer catalog) shows
// billing's English text. Which features a plan lists, and their numbers, are billing's.
import type { Translate } from '@/i18n/use-translate'
import type { OrcaPlanFeature } from '../../../../../shared/orca-billing-plans'
import { formatCents, formatRateCents } from './plans-pricing'
import { ORCA_CLOUD_SANDBOX_SPEC } from '../../../../../shared/hosted-sandbox/hosted-sandbox-wire'

/** Plan-level numbers some feature lines quote (the overage rate and default cap). */
export type PlanFeatureContext = {
  overage: { centsPerHour: number; defaultSpendCapCents: number } | null
  currency: string
}

function numberParam(feature: OrcaPlanFeature, key: string): number | null {
  const value = feature.params[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function planFeatureLine(
  feature: OrcaPlanFeature,
  context: PlanFeatureContext,
  t: Translate,
  locale: string
): string | null {
  const fallback = feature.text.trim() || null
  switch (feature.id) {
    case 'included_hours_per_seat': {
      const hours = numberParam(feature, 'hours')
      return hours === null
        ? fallback
        : t(
            'auto.components.billing.plans.featureHours4',
            '{{value0}} sandbox hours per seat each month, pooled across your team',
            { value0: String(hours) }
          )
    }
    case 'agents_keep_running':
      return t(
        'auto.components.billing.plans.featureKeepRunning',
        'Agents keep running when you close your laptop'
      )
    case 'idle_sleep': {
      const minutes = numberParam(feature, 'minutes')
      return minutes === null
        ? t(
            'auto.components.billing.plans.featureIdleSleep',
            'Sandboxes sleep when idle, so you only use hours while they work'
          )
        : t(
            'auto.components.billing.plans.featureSleep3',
            'Sleeps after {{value0}} minutes idle, so quiet time is free',
            { value0: String(minutes) }
          )
    }
    case 'overage_optional':
      return context.overage
        ? t(
            'auto.components.billing.plans.featureOverage7',
            'Optional overage at {{rate}} per sandbox hour, billed by the minute, up to a monthly spend cap you set ({{cap}} by default)',
            {
              rate: formatRateCents(context.overage.centsPerHour, locale, context.currency),
              cap: formatCents(context.overage.defaultSpendCapCents, locale, context.currency)
            }
          )
        : t(
            'auto.components.billing.plans.featureOverageNoRate',
            'Optional overage up to a monthly spend cap you set'
          )
    case 'sandbox_spec':
      // The product's one sandbox size (glossary): the catalog only says to list it.
      return t(
        'auto.components.billing.plans.featureSpec',
        'Every sandbox gets {{value0}} vCPU · {{value1}} GB',
        {
          value0: String(ORCA_CLOUD_SANDBOX_SPEC.vcpus),
          value1: String(ORCA_CLOUD_SANDBOX_SPEC.memoryGb)
        }
      )
    case 'ready_in_seconds':
      return t(
        'auto.components.billing.plans.featureReady',
        'Ready in seconds, nothing to set up or host'
      )
    case 'byoc':
      return t('auto.components.billing.plans.entByoc', 'Run sandboxes in your own cloud account')
    case 'sso_scim':
      return t('auto.components.billing.plans.entSso', 'SSO, SCIM provisioning and audit logs')
    case 'egress_controls':
      return t('auto.components.billing.plans.entNetwork', 'Network policy and egress controls')
    case 'custom_limits':
      return t('auto.components.billing.plans.entTerms', 'Custom limits, invoicing and terms')
    default:
      return fallback
  }
}

export function planFeatureLines(
  features: readonly OrcaPlanFeature[],
  context: PlanFeatureContext,
  t: Translate,
  locale: string
): string[] {
  return features.flatMap((feature) => {
    const line = planFeatureLine(feature, context, t, locale)
    return line ? [line] : []
  })
}
