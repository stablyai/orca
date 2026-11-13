import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { CommunityActivity } from '../../../../shared/community-operations'
import { communityActivityGroups, communityOutcomeCounts } from './community-activity-series'
import type { CommunityGroupMode } from './community-activity-series'
import { CommunityChartLegend, useCommunityGroupNames } from './CommunityChartLegend'

export function CommunityOutcomeFlow({
  data,
  mode
}: {
  data: CommunityActivity
  mode: CommunityGroupMode
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const names = useCommunityGroupNames(mode)
  const groups = communityActivityGroups(data, mode).filter((group) => group.rows.length)
  const outcomes = [
    t('community.sourceMerge', 'Merged into source'),
    t('community.stillOpen', 'Still open'),
    t('community.closedWithoutMerge', 'Closed without merge')
  ]
  const totals = communityOutcomeCounts(data.rows)
  const scale = 240 / Math.max(1, data.rows.length)
  const targetY = totals.map(
    (_, i) => 20 + totals.slice(0, i).reduce((a, b) => a + b, 0) * scale + i * 16
  )
  const links = groups.map((group, groupIndex) => {
    const y =
      20 +
      groups.slice(0, groupIndex).reduce((sum, entry) => sum + entry.rows.length * scale + 12, 0)
    const counts = communityOutcomeCounts(group.rows)
    return {
      ...group,
      y,
      paths: counts.map((count, i) => {
        const height = count * scale
        const from = y + counts.slice(0, i).reduce((sum, value) => sum + value, 0) * scale
        const to =
          targetY[i] +
          groups
            .slice(0, groupIndex)
            .reduce((sum, entry) => sum + communityOutcomeCounts(entry.rows)[i], 0) *
            scale
        return {
          count,
          outcome: outcomes[i],
          d: `M180,${from} C370,${from} 430,${to} 620,${to} L620,${to + height} C430,${to + height} 370,${from + height} 180,${from + height} Z`
        }
      })
    }
  })
  return (
    <section className="min-w-0 space-y-5 rounded-xl border border-border bg-card p-6 text-card-foreground">
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <p className="text-2xs text-muted-foreground">
            05 · {t('community.outcomes', 'Follow the outcomes')}
          </p>
          <h3 className="mt-2 text-base font-semibold">
            {t('community.outcomeFlow', 'Where does each group’s work go?')}
          </h3>
        </div>
        <CommunityChartLegend mode={mode} />
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          'community.flowWidth',
          'Wider paths mean more PRs. Outcomes are observed at the capture date.'
        )}
      </p>
      <div className="overflow-x-auto scrollbar-sleek">
        <svg
          viewBox="0 0 800 310"
          className="w-full min-w-[40rem]"
          role="img"
          aria-label={t('community.outcomeFlow', 'Where does each group’s work go?')}
        >
          {links.map((group) => (
            <g key={group.id}>
              {group.paths
                .filter((path) => path.count)
                .map((path) => (
                  <path key={path.outcome} d={path.d} fill={group.color} fillOpacity="0.65">
                    <title>
                      {names[group.id]} → {path.outcome}: {path.count}
                    </title>
                  </path>
                ))}
              <rect
                x="174"
                y={group.y}
                width="6"
                height={group.rows.length * scale}
                rx="2"
                fill={group.color}
              />
              <text
                x="162"
                y={group.y + (group.rows.length * scale) / 2}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-foreground text-xs"
              >
                {names[group.id]} · {group.rows.length.toLocaleString(locale)}
              </text>
            </g>
          ))}
          {totals.map((count, i) => (
            <g key={outcomes[i]}>
              <rect
                x="620"
                y={targetY[i]}
                width="6"
                height={count * scale}
                rx="2"
                fill="var(--muted-foreground)"
              />
              <text
                x="638"
                y={targetY[i] + (count * scale) / 2}
                dominantBaseline="middle"
                className="fill-foreground text-xs"
              >
                {outcomes[i]} · {count.toLocaleString(locale)}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          {t('community.chartData', 'View chart data')}
        </summary>
        <div className="mt-3 overflow-auto scrollbar-sleek">
          <table className="w-full text-left">
            <thead>
              <tr>
                <th className="p-2">{t('community.authorGroup', 'Author group')}</th>
                {outcomes.map((name) => (
                  <th className="p-2 text-right" key={name}>
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr key={group.id}>
                  <th className="p-2 font-normal">{names[group.id]}</th>
                  {communityOutcomeCounts(group.rows).map((count, i) => (
                    <td className="p-2 text-right" key={outcomes[i]}>
                      {count}
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
