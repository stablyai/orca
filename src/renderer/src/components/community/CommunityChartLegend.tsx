import { useTranslate } from '@/i18n/use-translate'
import { COMMUNITY_GROUPS, COMMUNITY_GROUP_COLORS } from './community-activity-series'
import type { CommunityAuthorGroup, CommunityGroupMode } from './community-activity-series'

export function useCommunityGroupNames(mode: CommunityGroupMode) {
  const t = useTranslate()
  return {
    community: t('community.communityAuthors', 'Community'),
    team:
      mode === 'roles'
        ? t('community.maintainers', 'Maintainers')
        : t('community.repoTeam', 'Repo team'),
    automation: t('community.automationAuthors', 'Automation'),
    unknown: t('community.unclassifiedAuthors', 'Unclassified')
  }
}

export function CommunityChartLegend({
  mode,
  groups = COMMUNITY_GROUPS
}: {
  mode: CommunityGroupMode
  groups?: readonly CommunityAuthorGroup[]
}): React.JSX.Element {
  const names = useCommunityGroupNames(mode)
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
      {groups.map((id) => (
        <span key={id} className="flex items-center gap-2">
          <span
            className="size-2 shrink-0 rounded-full"
            style={{ background: COMMUNITY_GROUP_COLORS[id] }}
          />
          {names[id]}
        </span>
      ))}
    </div>
  )
}
