import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { CommunityActivity } from '../../../../shared/community-operations'
import {
  communityActivityWeeks,
  COMMUNITY_GROUPS,
  COMMUNITY_GROUP_COLORS
} from './community-activity-series'
import type { CommunityGroupMode } from './community-activity-series'
import { CommunityChartLegend, useCommunityGroupNames } from './CommunityChartLegend'

export function CommunitySubmissionTrend({
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
  const max = Math.max(
    1,
    ...weeks.map((week) => week.groups.reduce((sum, group) => sum + group.count, 0))
  )
  const x = (i: number): number => 40 + (i / Math.max(1, weeks.length - 1)) * 700
  const y = (count: number): number => 200 - (count / max) * 160
  return (
    <section className="min-w-0 space-y-5 rounded-xl border border-border bg-card p-6 text-card-foreground">
      <div>
        <p className="text-2xs text-muted-foreground">
          03 · {t('community.activityOverTime', 'Activity over time')}
        </p>
        <h3 className="mt-2 text-base font-semibold">
          {t('community.proposedVolume', 'How much work is being proposed?')}
        </h3>
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          'community.localWeeks',
          'PR submissions by week in your time zone. The first and last weeks can be incomplete.'
        )}{' '}
        · {Intl.DateTimeFormat(locale).resolvedOptions().timeZone}
      </p>
      <div className="overflow-x-auto scrollbar-sleek">
        <svg
          viewBox="0 0 800 240"
          className="w-full min-w-[40rem]"
          role="img"
          aria-label={t('community.weeklyChart', 'Weekly PR submission counts')}
        >
          {[0, 0.5, 1].map((tick) => (
            <g key={tick}>
              <line x1="40" x2="740" y1={y(max * tick)} y2={y(max * tick)} stroke="var(--border)" />
              <text
                x="30"
                y={y(max * tick)}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-muted-foreground text-2xs"
              >
                {Math.round(max * tick)}
              </text>
            </g>
          ))}
          {COMMUNITY_GROUPS.map((id, groupIndex) => {
            const upper = weeks.map(
              (week, i) =>
                `${x(i)},${y(week.groups.slice(0, groupIndex + 1).reduce((sum, group) => sum + group.count, 0))}`
            )
            const lower = weeks
              .map(
                (week, i) =>
                  `${x(i)},${y(week.groups.slice(0, groupIndex).reduce((sum, group) => sum + group.count, 0))}`
              )
              .toReversed()
            return (
              <path
                key={id}
                d={`M${upper.join(' L')} L${lower.join(' L')} Z`}
                fill={COMMUNITY_GROUP_COLORS[id]}
                fillOpacity="0.85"
              >
                <title>{names[id]}</title>
              </path>
            )
          })}
          {weeks.map(
            (week, i) =>
              (i % Math.max(1, Math.ceil(weeks.length / 4)) === 0 || i === weeks.length - 1) && (
                <text
                  key={week.date}
                  x={x(i)}
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
      <CommunityChartLegend mode={mode} />
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          {t('community.chartData', 'View chart data')}
        </summary>
        <div className="mt-3 overflow-auto scrollbar-sleek">
          <table className="w-full text-left">
            <thead>
              <tr>
                <th className="p-2">{t('community.week', 'Week')}</th>
                {COMMUNITY_GROUPS.map((id) => (
                  <th className="p-2 text-right" key={id}>
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
                  {week.groups.map((group) => (
                    <td className="p-2 text-right" key={group.id}>
                      {group.count}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  )
}
