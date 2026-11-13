import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { CommunityActivity } from '../../../../shared/community-operations'
import { communityActivityGroups } from './community-activity-series'
import type { CommunityGroupMode } from './community-activity-series'
import { useCommunityGroupNames } from './CommunityChartLegend'

export function CommunityContributionChart({
  data,
  mode
}: {
  data: CommunityActivity
  mode: CommunityGroupMode
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const names = useCommunityGroupNames(mode)
  const groups = communityActivityGroups(data, mode)
  const total = data.rows.length
  return (
    <section className="space-y-6 rounded-xl border border-border bg-card p-6 text-card-foreground">
      <div>
        <p className="text-2xs text-muted-foreground">
          02 · {t('community.contributionShare', 'Contribution share')}
        </p>
        <h3 className="mt-2 text-base font-semibold">
          {t('community.whoSubmits', 'Who opens the PRs?')}
        </h3>
      </div>
      <div className="relative mx-auto size-48">
        <svg
          viewBox="0 0 100 100"
          className="size-full -rotate-90"
          role="img"
          aria-label={t('community.contributionShare', 'Contribution share')}
        >
          <circle cx="50" cy="50" r="40" fill="none" stroke="var(--muted)" strokeWidth="10" />
          {groups.map((group, i) => {
            const length = total ? (group.rows.length / total) * 251.33 : 0
            const start = total
              ? (groups.slice(0, i).reduce((sum, entry) => sum + entry.rows.length, 0) / total) *
                251.33
              : 0
            return (
              <circle
                key={group.id}
                cx="50"
                cy="50"
                r="40"
                fill="none"
                stroke={group.color}
                strokeWidth="10"
                strokeDasharray={`${length} 251.33`}
                strokeDashoffset={-start}
              >
                <title>
                  {names[group.id]}: {group.rows.length}/{total}
                </title>
              </circle>
            )
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <strong className="text-3xl">{total.toLocaleString(locale)}</strong>
          <span className="mt-1 text-xs text-muted-foreground">
            {t('community.submittedPRs', 'submitted PRs')}
          </span>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-4 text-xs">
        {groups.map((group) => (
          <div key={group.id}>
            <dt className="flex items-center gap-2 text-muted-foreground">
              <span className="size-2 rounded-full" style={{ background: group.color }} />
              {names[group.id]}
            </dt>
            <dd className="mt-1 font-medium">
              {group.rows.length.toLocaleString(locale)}{' '}
              <span className="ml-1 text-muted-foreground">
                {total
                  ? new Intl.NumberFormat(locale, {
                      style: 'percent',
                      maximumFractionDigits: 1
                    }).format(group.rows.length / total)
                  : '—'}
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
