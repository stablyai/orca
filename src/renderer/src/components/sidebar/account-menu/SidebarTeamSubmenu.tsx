import { useSyncExternalStore } from 'react'
import { ChevronsUpDown, User } from 'lucide-react'
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
import { openTeamPage } from '../../billing/team/team-page-store'

// The pick in flight, shared across menu opens: the menu unmounts on select, so component state
// would forget it and let a second pick race the first.
let pendingOrg: string | null = null
const pendingListeners = new Set<() => void>()
function setPendingOrg(next: string | null): void {
  pendingOrg = next
  for (const listener of pendingListeners) {
    listener()
  }
}
function subscribePending(listener: () => void): () => void {
  pendingListeners.add(listener)
  return () => pendingListeners.delete(listener)
}

/**
 * Team switcher in the account menu for signed-in accounts: the teams (radio items) and
 * "Create a team…".
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
  const pendingOrgId = useSyncExternalStore(subscribePending, () => pendingOrg)
  if (authStatus?.state !== 'connected') {
    return null
  }
  // Always present for signed-in accounts so "Create a team…" is one click away.
  const organizations = authStatus.organizations ?? []
  const activeOrgId = authStatus.cloud?.activeOrgId ?? ''
  const activeName = authStatus.cloud?.activeOrgName ?? null

  const switchTo = (orgId: string): void => {
    const org = organizations.find((candidate) => candidate.orgId === orgId)
    if (!org || orgId === activeOrgId || pendingOrg !== null) {
      return
    }
    setPendingOrg(orgId)
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
        setPendingOrg(null)
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
        {activeName ? <ChevronsUpDown className="size-3.5" /> : <User className="size-3.5" />}
        <span className="min-w-0 flex-1 truncate">
          {activeName ?? t('auto.components.sidebar.teamSwitcher.personal', 'Personal account')}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-60">
        {organizations.length > 0 ? (
          <>
            <DropdownMenuRadioGroup
              value={pendingOrgId ?? activeOrgId}
              onValueChange={switchTo}
              aria-busy={pendingOrgId !== null || undefined}
            >
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
