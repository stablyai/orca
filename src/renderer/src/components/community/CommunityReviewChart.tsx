import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { CommunityActivity } from '../../../../shared/community-operations'
import { communityActivityGroups } from './community-activity-series'
import type { CommunityGroupMode } from './community-activity-series'
import { useCommunityGroupNames } from './CommunityChartLegend'
export function CommunityReviewChart({
  data,
  mode,
  onModeChange
}: {
  data: CommunityActivity
  mode: CommunityGroupMode
  onModeChange: (mode: CommunityGroupMode) => void
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const names = useCommunityGroupNames(mode)
  const groups = communityActivityGroups(data, mode)
    .filter((group) => group.id === 'community' || group.id === 'team')
    .map((group) => ({ ...group, name: names[group.id] }))
  const measures = [
    {
      name:
        mode === 'roles'
          ? t('community.maintainerReview', 'Received maintainer review')
          : t('community.teamReview', 'Received team code review'),
      field: mode === 'roles' ? ('maintainerReviewed' as const) : ('memberReviewed' as const)
    },
    {
      name:
        mode === 'roles'
          ? t('community.maintainerApproval', 'Received maintainer approval')
          : t('community.teamApproval', 'Received team approval'),
      field: mode === 'roles' ? ('maintainerApproved' as const) : ('memberApproved' as const)
    },
    { name: t('community.sourceMerge', 'Merged into source'), field: 'merged' as const }
  ]
  const available = mode !== 'roles' || data.maintainers !== null
  return (
    <section className="space-y-6 rounded-xl border border-border bg-card p-6 text-card-foreground">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold">
            {t('community.compareDecisions', 'What happens to each group’s PRs?')}
          </h3>
          <p className="mt-2 text-xs text-muted-foreground">
            {t(
              'community.compareDenominator',
              'Each bar shows the share of submissions in its author group. The numerator and denominator stay visible.'
            )}
          </p>
        </div>
        <Select
          value={mode}
          onValueChange={(value) => {
            if (value === 'roles' || value === 'affiliation') {
              onModeChange(value)
            }
          }}
        >
          <SelectTrigger
            className="w-52"
            aria-label={t('community.groupEvidence', 'Evidence used for author groups')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="affiliation">
              {t('community.publicGroups', 'Public GitHub groups')}
            </SelectItem>
            <SelectItem value="roles">
              {t('community.verifiedRoles', 'Verified maintainer roles')}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      {available ? (
        <div className="space-y-6">
          {measures.map((measure) => (
            <div className="space-y-3" key={measure.field}>
              <h4 className="text-sm font-medium">{measure.name}</h4>
              {groups.map((group) => {
                const known = group.rows.filter((row) => row[measure.field] !== null)
                const count = known.filter((row) => row[measure.field]).length
                const rate = known.length ? count / known.length : null
                return (
                  <div
                    key={group.name}
                    className="grid grid-cols-[5rem_1fr_5rem] items-center gap-3 text-xs max-sm:grid-cols-[4rem_1fr_4rem]"
                  >
                    <span className="text-muted-foreground">{group.name}</span>
                    <div className="h-5 rounded-md bg-muted">
                      <div
                        className="h-full rounded-md"
                        style={{ width: `${100 * (rate ?? 0)}%`, background: group.color }}
                      />
                    </div>
                    <span className="text-right font-medium">
                      {rate === null
                        ? t('community.noEvidence', 'No evidence')
                        : `${new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(rate)} · ${count}/${known.length}`}
                    </span>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{data.roleError}</p>
      )}
      <p className="text-xs leading-relaxed text-muted-foreground">
        {mode === 'roles'
          ? t(
              'community.verifiedDefinition',
              'Maintainer groups use verified current GitHub admin or maintain permissions.'
            )
          : t(
              'community.teamDefinition',
              'Repo team uses GitHub’s owner, member, or collaborator affiliation. Select verified maintainer roles for the admin-level comparison when role evidence is available.'
            )}
      </p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t(
          'community.reviewDefinition',
          'Review means a non-dismissed submitted review. Approval means at least one non-dismissed approval. Missing review history is excluded from that measure. A merge does not prove approval or release.'
        )}
      </p>
    </section>
  )
}
