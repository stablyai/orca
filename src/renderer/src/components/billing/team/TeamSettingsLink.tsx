import { ChevronRight } from 'lucide-react'
import { SettingsGroupHeader } from '@/components/settings/section-layout/SettingsGroup'
import { useTranslate } from '@/i18n/use-translate'
import { TeamMark } from './TeamAvatar'
import { memberCountLabel } from './team-copy'
import { openTeamPage } from './team-page-store'
import { useOrgRoster } from './use-org-roster'

/** Settings → Orca account: one row that opens the Team page (members, invites, seats). */
export function TeamSettingsLink({
  orgId,
  orgName
}: {
  orgId: string | null
  orgName: string | null
}): React.JSX.Element {
  const t = useTranslate()
  const roster = useOrgRoster(orgId)
  const members = roster.result?.status === 'ok' ? roster.result.roster.members.length : null
  return (
    <div className="space-y-3 border-t border-border/60 pt-5">
      <SettingsGroupHeader
        className="px-0"
        title={t('auto.components.billing.team.title', 'Team')}
      />
      <button
        type="button"
        onClick={() => openTeamPage()}
        className="flex w-full items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-left shadow-xs transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:outline-none"
      >
        {orgName ? <TeamMark name={orgName} className="size-8 text-xs" /> : null}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">
            {orgName ?? t('auto.components.billing.team.createTitle', 'Create a team')}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {orgName
              ? members === null
                ? t('auto.components.billing.team.manage', 'Members, invites and seats')
                : `${memberCountLabel(members, t)} · ${t('auto.components.billing.team.manage', 'Members, invites and seats')}`
              : t(
                  'auto.components.billing.team.createHint',
                  'Share one Orca Cloud plan with your teammates.'
                )}
          </span>
        </span>
        <ChevronRight className="size-4 text-muted-foreground" />
      </button>
    </div>
  )
}
