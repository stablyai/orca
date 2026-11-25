import type { ClaudeAccountBinding } from '../../../../../../shared/agent-accounts/claude/claude-account-binding'
import type {
  ProviderRateLimits,
  RateLimitState
} from '../../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import {
  claudeBindingLabel,
  hostClaudeAccounts
} from '@/components/settings/repository/claude-account/claude-account-binding-options'

export type ProjectGroupClaudeAccount = {
  binding: ClaudeAccountBinding | undefined
  /** Null for an unbound group. */
  label: string | null
  /** Only saved accounts have a reading; a folder binding never does. */
  usage: ProviderRateLimits | null
  /** The nearest parent group whose account an unbound group's projects run on. */
  inheritedFrom: string | null
}

/** Name of the nearest local ancestor with its own binding, which an unbound group inherits. */
function inheritedBindingGroupName(
  groups: readonly ProjectGroup[],
  groupId: string
): string | null {
  const local = new Map(
    groups
      .filter((group) => getRepoExecutionHostId(group) === 'local')
      .map((group) => [group.id, group])
  )
  const seen = new Set([groupId])
  // Why the seen set: a corrupt parent chain must not loop forever.
  for (
    let parent = local.get(local.get(groupId)?.parentGroupId ?? '');
    parent && !seen.has(parent.id);
    parent = local.get(parent.parentGroupId ?? '')
  ) {
    seen.add(parent.id)
    if (parent.claudeAccount) {
      return parent.name
    }
  }
  return null
}

/** A saved account's last reading: the meter's own when it reads that account on the host. */
export function claudeAccountUsage(
  rateLimits: RateLimitState,
  settings: Pick<
    GlobalSettings,
    'activeClaudeManagedAccountId' | 'activeClaudeManagedAccountIdsByRuntime'
  > | null,
  accountId: string
): ProviderRateLimits | null {
  const selected =
    settings?.activeClaudeManagedAccountIdsByRuntime?.host ??
    settings?.activeClaudeManagedAccountId ??
    null
  if (selected === accountId && rateLimits.claudeTarget.runtime === 'host') {
    return rateLimits.claude
  }
  return (
    rateLimits.inactiveClaudeAccounts.find((entry) => entry.accountId === accountId)?.rateLimits ??
    null
  )
}

/** Null for a group on another host: its bindings name that host's folders and accounts. */
export function useProjectGroupClaudeAccount(
  groupId: string,
  hostId: ExecutionHostId | undefined
): ProjectGroupClaudeAccount | null {
  const t = useTranslate()
  const group = useAppStore((state) =>
    state.projectGroups.find(
      (candidate) =>
        candidate.id === groupId && (!hostId || getRepoExecutionHostId(candidate) === hostId)
    )
  )
  const inheritedFrom = useAppStore((state) =>
    inheritedBindingGroupName(state.projectGroups, groupId)
  )
  const settings = useAppStore((state) => state.settings)
  const rateLimits = useAppStore((state) => state.rateLimits)
  if (!group || getRepoExecutionHostId(group) !== 'local') {
    return null
  }
  const binding = group.claudeAccount
  if (!binding) {
    return { binding, label: null, usage: null, inheritedFrom }
  }
  return {
    binding,
    label: claudeBindingLabel(
      binding,
      hostClaudeAccounts(settings),
      settings?.managedAccountDisplayNames,
      t
    ),
    usage:
      binding.kind === 'managed'
        ? claudeAccountUsage(rateLimits, settings, binding.accountId)
        : null,
    inheritedFrom
  }
}
