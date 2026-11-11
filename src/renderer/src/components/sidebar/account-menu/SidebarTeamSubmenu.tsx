import { ChevronsUpDown, User } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import type { OrcaProfileAuthStatus } from '../../../../../shared/orca-profiles'
import { openTeamPage } from '../../billing/team/team-page-store'
import { switchActiveTeam, usePendingTeamSwitch } from './switch-active-team'

const PERSONAL_VALUE = '__personal__'

/**
 * Team switcher in the account menu for signed-in accounts: the teams (radio items) and
 * "Create a team…".
 * Radio items (menuitemradio + aria-checked) carry the current team for screen readers; the
 * "Team" item below it still opens the Team page. Switching selects the org at Orca Cloud auth,
 * which re-scopes billing, seats and the Team page.
 */
export function SidebarTeamSubmenu({
  authStatus,
  usage = null
}: {
  authStatus: OrcaProfileAuthStatus | null
  /** The active plan's hours (and its usage alert), shown on the team row because they're the team's. */
  usage?: { hoursLeft: string; warning: string | null } | null
}): React.JSX.Element | null {
  const t = useTranslate()
  const pendingOrgId = usePendingTeamSwitch()
  if (authStatus?.state !== 'connected') {
    return null
  }
  // Always present for signed-in accounts so "Create a team…" is one click away.
  const organizations = authStatus.organizations ?? []
  const activeOrgId = authStatus.cloud?.activeOrgId ?? ''
  const activeName = authStatus.cloud?.activeOrgName ?? null

  const switchTo = (value: string): void => {
    const personal = value === PERSONAL_VALUE
    const org = organizations.find((candidate) => candidate.orgId === value)
    if ((!org && !personal) || value === (activeOrgId || PERSONAL_VALUE)) {
      return
    }
    const label =
      org?.name ?? t('auto.components.sidebar.teamSwitcher.personal', 'Personal account')
    void switchActiveTeam({ orgId: personal ? null : value, label, pendingKey: value, t })
  }

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        data-account-menu-team-switcher=""
        aria-label={
          activeName
            ? t(
                'auto.components.sidebar.teamSwitcher.triggerLabel',
                'Team: {{value0}}, switch teams',
                {
                  value0: activeName
                }
              )
            : t(
                'auto.components.sidebar.teamSwitcher.triggerPersonal',
                'Personal account, switch teams'
              )
        }
      >
        {activeName ? <ChevronsUpDown className="size-3.5" /> : <User className="size-3.5" />}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">
            {activeName ?? t('auto.components.sidebar.teamSwitcher.personal', 'Personal account')}
          </span>
          {usage ? (
            <span className="truncate text-xs text-muted-foreground tabular-nums">
              {usage.hoursLeft}
            </span>
          ) : null}
          {usage?.warning ? (
            <span className="text-xs text-foreground text-pretty">{usage.warning}</span>
          ) : null}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-60">
        {organizations.length > 0 ? (
          <>
            <DropdownMenuRadioGroup
              value={pendingOrgId ?? (activeOrgId || PERSONAL_VALUE)}
              onValueChange={switchTo}
              aria-busy={pendingOrgId !== null || undefined}
            >
              <DropdownMenuRadioItem value={PERSONAL_VALUE}>
                <span className="min-w-0 flex-1 truncate">
                  {t('auto.components.sidebar.teamSwitcher.personal', 'Personal account')}
                </span>
              </DropdownMenuRadioItem>
              {organizations.map((org) => (
                <DropdownMenuRadioItem key={org.orgId} value={org.orgId} title={org.name}>
                  <span className="min-w-0 flex-1 truncate">{org.name}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem inset onSelect={() => openTeamPage({ kind: 'create' })}>
          {t('auto.components.sidebar.teamSwitcher.create', 'Create a team…')}
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
