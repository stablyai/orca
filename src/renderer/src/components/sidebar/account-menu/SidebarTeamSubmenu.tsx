import { Check, Plus, Settings2, Users } from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import type { OrcaProfileAuthStatus } from '../../../../../shared/orca-profiles'
import { TeamMark } from '../../billing/team/TeamAvatar'
import { openTeamPage } from '../../billing/team/team-page-store'

/**
 * Team switcher in the account menu, shown when the account belongs to more than one team: the
 * teams (the active one checked) and "Manage team…". Switching selects the org at Orca Cloud auth,
 * which re-scopes billing, seats and the Team page. Single-team accounts use the "Team" item.
 */
export function SidebarTeamSubmenu({
  authStatus
}: {
  authStatus: OrcaProfileAuthStatus | null
}): React.JSX.Element | null {
  const t = useTranslate()
  const selectOrg = useAppStore((state) => state.selectOrcaProfileOrg)
  if (authStatus?.state !== 'connected') {
    return null
  }
  const organizations = authStatus.organizations ?? []
  if (organizations.length < 2) {
    return null
  }
  const activeOrgId = authStatus.cloud?.activeOrgId ?? null
  const activeName = authStatus.cloud?.activeOrgName ?? null

  const switchTo = (orgId: string, name: string): void => {
    void selectOrg(orgId).then((result) => {
      if (result?.status === 'selected') {
        toast.success(
          t('auto.components.sidebar.teamSwitcher.switched', 'Switched to {{value0}}', {
            value0: name
          })
        )
      } else {
        toast.error(
          t('auto.components.sidebar.teamSwitcher.failed', 'Couldn’t switch teams. Try again.')
        )
      }
    })
  }

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-account-menu-team-switcher="">
        {activeName ? (
          <TeamMark
            name={activeName}
            className="size-3.5 rounded-[3px] border-0 text-[7px] shadow-none"
          />
        ) : (
          <Users className="size-3.5" />
        )}
        <span className="min-w-0 flex-1 truncate">
          {activeName ?? t('auto.components.sidebar.teamSwitcher.personal', 'Personal account')}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-60">
        {organizations.map((org) => {
          const current = org.orgId === activeOrgId
          return (
            <DropdownMenuItem
              key={org.orgId}
              data-current={current ? 'true' : undefined}
              aria-current={current ? 'true' : undefined}
              onSelect={() => (current ? openTeamPage() : switchTo(org.orgId, org.name))}
            >
              <TeamMark name={org.name} className="size-5 rounded-[5px] text-[9px] shadow-none" />
              <span className="min-w-0 flex-1 truncate">{org.name}</span>
              {current ? <Check className="size-3.5" /> : null}
            </DropdownMenuItem>
          )
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openTeamPage({ kind: 'create' })}>
          <Plus className="size-3.5" />
          {t('auto.components.sidebar.teamSwitcher.create', 'Create a team…')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openTeamPage()}>
          <Settings2 className="size-3.5" />
          {t('auto.components.sidebar.teamSwitcher.manage', 'Manage team…')}
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
