import type {
  InactiveAccountUsage,
  ProviderRateLimits
} from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { formatPlanLabel } from '@/components/status-bar/usage/usage-roster-formatting'
import { isCodexPlanWorkspaceLabel } from '../../../../shared/agent-accounts/codex/codex-plan-workspace-label'

type PlanReading = { label: string; runtime: 'host' | 'wsl'; wslDistro: string | null }

export type ObservedAccountPlans = ReadonlyMap<string, PlanReading>

/** Plans keyed by the saved account each successful reading names, never by which account a
 *  roster says is selected: another window may have switched since that roster was read. */
export function indexObservedAccountPlans(
  active: ProviderRateLimits | null | undefined,
  inactive: readonly InactiveAccountUsage[] | null | undefined
): ObservedAccountPlans {
  const plans = new Map<string, PlanReading & { updatedAt: number }>()
  const add = (reading: ProviderRateLimits | null | undefined, cacheId?: string): void => {
    const account = reading?.usageMetadata?.readingAccount
    const label = formatPlanLabel(reading?.planType, reading?.provider)
    if (
      !reading ||
      !account ||
      !label ||
      (cacheId !== undefined && cacheId !== account.accountId)
    ) {
      return
    }
    const current = plans.get(account.accountId)
    if (!current || current.updatedAt < reading.updatedAt) {
      plans.set(account.accountId, {
        label,
        runtime: account.runtime,
        wslDistro: account.wslDistro,
        updatedAt: reading.updatedAt
      })
    }
  }
  add(active)
  for (const entry of inactive ?? []) {
    add(entry.rateLimits, entry.accountId)
  }
  return plans
}

export function getObservedAccountPlan(
  plans: ObservedAccountPlans,
  accountId: string,
  slot: { runtime: 'host' | 'wsl'; wslDistro: string | null }
): string | null {
  const reading = plans.get(accountId)
  if (!reading || reading.runtime !== slot.runtime) {
    return null
  }
  // A WSL reading belongs to one named distro, never to whichever distro is the default.
  return slot.runtime === 'host' ||
    (reading.wslDistro !== null &&
      reading.wslDistro.toLowerCase() === slot.wslDistro?.toLowerCase())
    ? reading.label
    : null
}

/** A saved label like "Personal (Plus)" may already name a plan; never add a second, different one. */
export function getObservedCodexAccountPlan(
  plans: ObservedAccountPlans,
  account: { id: string; workspaceLabel?: string | null },
  slot: { runtime: 'host' | 'wsl'; wslDistro: string | null }
): string | null {
  return isCodexPlanWorkspaceLabel(account.workspaceLabel)
    ? null
    : getObservedAccountPlan(plans, account.id, slot)
}
