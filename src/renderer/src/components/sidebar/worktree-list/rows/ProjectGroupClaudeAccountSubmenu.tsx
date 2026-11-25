import type { ClaudeAccountBinding } from '../../../../../../shared/agent-accounts/claude/claude-account-binding'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { normalizeUsagePercentageDisplay } from '../../../../../../shared/agent-usage/display/usage-percentage-display'
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { ClaudeIcon } from '@/components/status-bar/accounts/provider-icons'
import { getTightestUsageSection } from '@/components/status-bar/usage/usage-headline-sections'
import { formatBareUsagePercentage } from '@/components/status-bar/usage/usage-percentage-label'
import {
  claudeAccountName,
  claudeAccountOptionValue,
  claudeBindingFromValue,
  claudeBindingValue,
  hostClaudeAccounts,
  UNBOUND_BINDING_VALUE
} from '@/components/settings/repository/claude-account/claude-account-binding-options'
import { claudeAccountUsage, useProjectGroupClaudeAccount } from './project-group-claude-account'

/** Picks the Claude account a group's projects run on, each saved account with its tightest usage. */
export function ProjectGroupClaudeAccountSubmenu({
  groupId,
  hostId
}: {
  groupId: string
  hostId: ExecutionHostId | undefined
}): React.JSX.Element | null {
  const t = useTranslate()
  const account = useProjectGroupClaudeAccount(groupId, hostId)
  const settings = useAppStore((state) => state.settings)
  const rateLimits = useAppStore((state) => state.rateLimits)
  const display = normalizeUsagePercentageDisplay(
    useAppStore((state) => state.usagePercentageDisplay)
  )
  const updateProjectGroup = useAppStore((state) => state.updateProjectGroup)
  const fetchInactiveUsage = useAppStore((state) => state.fetchInactiveClaudeAccountUsage)
  if (!account) {
    return null
  }
  const accounts = hostClaudeAccounts(settings)
  const current = claudeBindingValue(account.binding)
  const save = (next: ClaudeAccountBinding | null): void => {
    void updateProjectGroup(groupId, { claudeAccount: next }, hostId ? { hostId } : undefined)
  }
  return (
    <>
      <DropdownMenuSub
        onOpenChange={(open) => {
          // Why: other accounts' usage is read on demand, as the status bar switcher does.
          if (open) {
            void fetchInactiveUsage()
          }
        }}
      >
        <DropdownMenuSubTrigger>
          <ClaudeIcon size={14} className="shrink-0" />
          {t('auto.components.sidebar.ProjectGroupClaudeAccount.menu', 'Claude account')}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="min-w-56">
          <DropdownMenuRadioGroup
            value={current}
            onValueChange={(value) => {
              const next = claudeBindingFromValue(value)
              if (value !== current && next !== undefined) {
                save(next)
              }
            }}
          >
            <DropdownMenuRadioItem value={UNBOUND_BINDING_VALUE}>
              {/* An unbound nested group runs on its parent's account, not the selection. */}
              {account.inheritedFrom
                ? t(
                    'auto.components.sidebar.ProjectGroupClaudeAccount.useParentGroup',
                    'Use {{group}}’s account',
                    { group: account.inheritedFrom }
                  )
                : t(
                    'auto.components.settings.RepositoryClaudeAccountSection.followSelection',
                    'Follow the selected account'
                  )}
            </DropdownMenuRadioItem>
            {accounts.map((saved) => {
              const usage = claudeAccountUsage(rateLimits, settings, saved.id)
              const tightest = usage ? getTightestUsageSection(usage, t) : null
              return (
                <DropdownMenuRadioItem key={saved.id} value={claudeAccountOptionValue(saved.id)}>
                  <span className="min-w-0 truncate">
                    {claudeAccountName(saved, settings?.managedAccountDisplayNames)}
                  </span>
                  {tightest ? (
                    <span className="ml-auto pl-3 text-xs tabular-nums text-muted-foreground">
                      {formatBareUsagePercentage(tightest.window.usedPercent, display, t)}
                    </span>
                  ) : null}
                </DropdownMenuRadioItem>
              )
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
    </>
  )
}
