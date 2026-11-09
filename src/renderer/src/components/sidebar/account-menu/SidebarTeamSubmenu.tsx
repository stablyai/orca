import { useRef } from 'react'
import { Plus, Users } from 'lucide-react'
import { toast } from 'sonner'
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
import { useAppStore } from '@/store'
import type { OrcaProfileAuthStatus } from '../../../../../shared/orca-profiles'
import { TeamMark } from '../../billing/team/TeamAvatar'
import { openTeamPage } from '../../billing/team/team-page-store'

/**
 * Team switcher in the account menu, shown when the account belongs to more than one team.
 * Radio items (menuitemradio + aria-checked) carry the current team for screen readers; the
 * "Team" item below it still opens the Team page. Switching selects the org at Orca Cloud auth,
 * which re-scopes billing, seats and the Team page.
 */
export function SidebarTeamSubmenu({
  authStatus
}: {
  authStatus: OrcaProfileAuthStatus | null
}): React.JSX.Element | null {
  const t = useTranslate()
  const selectOrg = useAppStore((state) => state.selectOrcaProfileOrg)
  // One switch at a time, so toasts can't arrive out of order.
  const switching = useRef(false)
  if (authStatus?.state !== 'connected') {
    return null
  }
  const organizations = authStatus.organizations ?? []
  if (organizations.length < 2) {
    return null
  }
  const activeOrgId = authStatus.cloud?.activeOrgId ?? ''
  const activeName = authStatus.cloud?.activeOrgName ?? null

  const switchTo = (orgId: string): void => {
    const org = organizations.find((candidate) => candidate.orgId === orgId)
    if (!org || orgId === activeOrgId || switching.current) {
      return
    }
    switching.current = true
    void selectOrg(orgId)
      .then((result) => {
        if (result?.status === 'selected') {
          toast.success(
            t('auto.components.sidebar.teamSwitcher.switched', 'Switched to {{value0}}', {
              value0: org.name
            })
          )
        } else {
          toast.error(
            t('auto.components.sidebar.teamSwitcher.failed', 'Couldn’t switch teams. Try again.')
          )
        }
      })
      .finally(() => {
        switching.current = false
      })
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
        <DropdownMenuRadioGroup value={activeOrgId} onValueChange={switchTo}>
          {organizations.map((org) => (
            <DropdownMenuRadioItem key={org.orgId} value={org.orgId}>
              <TeamMark name={org.name} className="size-5 rounded-[5px] text-[9px] shadow-none" />
              <span className="min-w-0 flex-1 truncate">{org.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openTeamPage({ kind: 'create' })}>
          <span className="ml-[18px] flex size-5 items-center justify-center">
            <Plus className="size-3.5" />
          </span>
          {t('auto.components.sidebar.teamSwitcher.create', 'Create a team…')}
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
