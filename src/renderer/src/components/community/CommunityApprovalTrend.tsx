import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { CommunityActivity } from '../../../../shared/community-operations'
import { communityActivityWeeks, COMMUNITY_GROUP_COLORS } from './community-activity-series'
import type { CommunityGroupMode } from './community-activity-series'
import { CommunityChartLegend, useCommunityGroupNames } from './CommunityChartLegend'

export function CommunityApprovalTrend({
  data,
  mode
}: {
  data: CommunityActivity
  mode: CommunityGroupMode
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const names = useCommunityGroupNames(mode)
  const weeks = communityActivityWeeks(data, mode)
  const humanGroups = ['community', 'team'] as const
  const known = data.rows.filter(
    (row) => (mode === 'roles' ? row.maintainerApproved : row.memberApproved) !== null
  ).length
  return (
    <section className="min-w-0 space-y-5 rounded-xl border border-border bg-card p-6 text-card-foreground">
      <div>
        <p className="text-2xs text-muted-foreground">
          06 · {t('community.reviewTrend', 'Review trend')}
        </p>
        <h3 className="mt-2 text-base font-semibold">
          {t('community.approvalOverTime', 'Does approval change over time?')}
        </h3>
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          'community.approvalCohort',
          'Observed approval by submission week. Missing review history is excluded; gaps mean no evidence.'
        )}{' '}
        {known}/{data.rows.length} {t('community.prsUnit', 'PRs')}.
      </p>
      <div className="overflow-x-auto scrollbar-sleek">
        <svg
          viewBox="0 0 800 240"
          className="w-full min-w-[40rem]"
          role="img"
          aria-label={t('community.approvalOverTime', 'Does approval change over time?')}
        >
          {[0, 0.5, 1].map((rate) => (
            <g key={rate}>
              <line
                x1="40"
                x2="740"
                y1={200 - rate * 160}
                y2={200 - rate * 160}
                stroke="var(--border)"
              />
              <text
                x="30"
                y={200 - rate * 160}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-muted-foreground text-2xs"
              >
                {rate * 100}%
              </text>
            </g>
          ))}
          {humanGroups.map((id) => {
            const points = weeks.map((week, i) => {
              const group = week.groups.find((entry) => entry.id === id)!
              return {
                x: 40 + (i / Math.max(1, weeks.length - 1)) * 700,
                y: 200 - (group.known ? group.approved / group.known : 0) * 160,
                ...group,
                date: week.date
              }
            })
            const path = points
              .map((point, i) => {
                if (!point.known) {
                  return ''
                }
                const command = points[i - 1]?.known ? 'L' : 'M'
                return `${command}${point.x},${point.y}`
              })
              .join(' ')
            return (
              <g key={id}>
                <path d={path} fill="none" stroke={COMMUNITY_GROUP_COLORS[id]} strokeWidth="2" />
                {points
                  .filter((point) => point.known)
                  .map((point) => (
                    <circle
                      key={point.date}
                      cx={point.x}
                      cy={point.y}
                      r="3"
                      fill={COMMUNITY_GROUP_COLORS[id]}
                    >
                      <title>
                        {names[id]} · {new Date(point.date).toLocaleDateString(locale)}:{' '}
                        {point.approved}/{point.known}
                      </title>
                    </circle>
                  ))}
              </g>
            )
          })}
          {weeks.map(
            (week, i) =>
              (i % Math.max(1, Math.ceil(weeks.length / 4)) === 0 || i === weeks.length - 1) && (
                <text
                  key={week.date}
                  x={40 + (i / Math.max(1, weeks.length - 1)) * 700}
                  y="228"
                  textAnchor="middle"
                  className="fill-muted-foreground text-2xs"
                >
                  {new Date(week.date).toLocaleDateString(locale, {
                    month: 'short',
                    day: 'numeric'
                  })}
                </text>
              )
          )}
        </svg>
      </div>
      <CommunityChartLegend mode={mode} groups={humanGroups} />
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          {t('community.chartData', 'View chart data')}
        </summary>
        <div className="mt-3 overflow-auto scrollbar-sleek">
          <table className="w-full text-left">
            <thead>
              <tr>
                <th className="p-2">{t('community.week', 'Week')}</th>
                {humanGroups.map((id) => (
                  <th key={id} className="p-2 text-right">
                    {names[id]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeks.map((week) => (
                <tr key={week.date}>
                  <th className="p-2 font-normal">
                    {new Date(week.date).toLocaleDateString(locale)}
                  </th>
                  {humanGroups.map((id) => {
                    const group = week.groups.find((entry) => entry.id === id)!
                    return (
                      <td className="p-2 text-right" key={id}>
                        {group.known ? `${group.approved}/${group.known}` : '—'}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  )
}
