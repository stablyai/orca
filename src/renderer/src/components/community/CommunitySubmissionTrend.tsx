import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { CommunityActivity } from '../../../../shared/community-operations'
export function CommunitySubmissionTrend({ data }: { data: CommunityActivity }): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const buckets = new Map<string, number>()
  for (const row of data.rows) {
    const date = new Date(row.createdAt)
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
    const key = date.toISOString().slice(0, 10)
    buckets.set(key, (buckets.get(key) ?? 0) + 1)
  }
  const rows = [...buckets].sort(([a], [b]) => a.localeCompare(b))
  const max = Math.max(1, ...rows.map(([, count]) => count))
  const points = rows.map(
    ([, count], i) =>
      `${32 + (i / Math.max(1, rows.length - 1)) * 736},${180 - (count / max) * 140}`
  )
  const observedReviews = data.rows.filter((row) => row.reviewed !== null)
  return (
    <section className="space-y-5 rounded-xl border border-border p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">
            {t('community.submissionTrend', 'PR submissions by week')}
          </h3>
          <p className="mt-2 text-xs text-muted-foreground">
            {t(
              'community.trendScope',
              'This capture, grouped by UTC week. The first and last weeks can be incomplete.'
            )}
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('community.reviewCoverage', 'Complete review history')} · {observedReviews.length}/
          {data.rows.length} {t('community.prsUnit', 'PRs')}
        </p>
      </div>
      <svg
        viewBox="0 0 800 220"
        className="w-full"
        role="img"
        aria-label={t('community.weeklyChart', 'Weekly PR submission counts')}
      >
        <line x1="32" x2="768" y1="180" y2="180" stroke="var(--border)" />
        {rows.length > 1 && (
          <>
            <path
              d={`M32,180 L${points.join(' L')} L768,180 Z`}
              fill="var(--foreground)"
              fillOpacity="0.06"
            />
            <polyline
              points={points.join(' ')}
              fill="none"
              stroke="var(--foreground)"
              strokeWidth="2"
            />
          </>
        )}
        {rows.map(([date, count], i) => {
          const [cx, cy] = points[i].split(',').map(Number)
          return (
            <g key={date}>
              <circle cx={cx} cy={cy} r="4" fill="var(--foreground)" />
              <text x={cx} y={cy - 12} textAnchor="middle" className="fill-foreground text-2xs">
                {count}
              </text>
              <text x={cx} y="208" textAnchor="middle" className="fill-muted-foreground text-2xs">
                {new Date(date).toLocaleDateString(locale, {
                  month: 'short',
                  day: 'numeric',
                  timeZone: 'UTC'
                })}
              </text>
            </g>
          )
        })}
      </svg>
    </section>
  )
}
