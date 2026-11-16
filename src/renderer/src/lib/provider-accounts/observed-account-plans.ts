import type { ProviderRateLimits } from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import {
  getObservedAccountUsage,
  type AccountUsageObservations
} from '../../../../shared/agent-usage/rate-limits/account-usage-observations'
import { formatPlanLabel } from '@/components/status-bar/usage/usage-roster-formatting'
import { isCodexPlanWorkspaceLabel } from '../../../../shared/agent-accounts/codex/codex-plan-workspace-label'

type AccountSlot = { runtime: 'host' | 'wsl'; wslDistro: string | null }

export type ObservedAccountUsage = AccountUsageObservations<ProviderRateLimits>

export function getObservedAccountPlan(
  observations: ObservedAccountUsage,
  accountId: string,
  slot: AccountSlot
): string | null {
  return formatPlanLabel(getObservedAccountUsage(observations, { accountId, ...slot })?.planType)
}

/** A saved label like "Personal (Plus)" may already name a plan; never add a second, different one. */
export function getObservedCodexAccountPlan(
  observations: ObservedAccountUsage,
  account: { id: string; workspaceLabel?: string | null },
  slot: AccountSlot
): string | null {
  return isCodexPlanWorkspaceLabel(account.workspaceLabel)
    ? null
    : getObservedAccountPlan(observations, account.id, slot)
}
