import { CommunitySubmissionTrend } from './CommunitySubmissionTrend'
import { CommunityReviewChart } from './CommunityReviewChart'
import { useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { CommunitySummary } from '../../../../shared/community-operations'
import { communityClient } from './community-client'
import { useCommunityResource } from './use-community-resource'
function Bars({
  rows,
  label
}: {
  rows: { name: string; count: number }[]
  label: string
}): React.JSX.Element {
  const locale = useIntlLocale()
  const max = Math.max(1, ...rows.map((row) => row.count))
  return (
    <div role="img" aria-label={label} className="space-y-4">
      {rows.map((row) => (
        <div key={row.name}>
          <div className="mb-1.5 flex justify-between gap-4 text-xs">
            <span>{row.name}</span>
            <strong>{row.count.toLocaleString(locale)}</strong>
          </div>
          <div className="h-2 rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-foreground/70"
              style={{ width: `${(100 * row.count) / max}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}
function Ring({
  numerator,
  denominator,
  label
}: {
  numerator: number
  denominator: number
  label: string
}): React.JSX.Element {
  const locale = useIntlLocale()
  const t = useTranslate()
  const rate = denominator ? numerator / denominator : 0
  return (
    <div className="flex items-center gap-6">
      <div className="relative size-32 shrink-0">
        <svg
          viewBox="0 0 100 100"
          role="img"
          aria-label={`${label}: ${numerator} / ${denominator}`}
          className="size-full -rotate-90"
        >
          <circle cx="50" cy="50" r="40" fill="none" stroke="var(--muted)" strokeWidth="9" />
          <circle
            cx="50"
            cy="50"
            r="40"
            fill="none"
            stroke="var(--foreground)"
            strokeWidth="9"
            strokeDasharray={`${rate * 251.33} 251.33`}
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-2xl font-semibold">
          {denominator ? `${Math.round(rate * 100)}%` : '—'}
        </span>
      </div>
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="mt-2 text-xs text-muted-foreground">
          {numerator.toLocaleString(locale)} / {denominator.toLocaleString(locale)}{' '}
          {t('community.prsUnit', 'PRs')}
        </p>
      </div>
    </div>
  )
}
export function CommunityActivity({
  target,
  summary
}: {
  target: RuntimeClientTarget
  summary: CommunitySummary
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const resource = useCommunityResource(
    useCallback(() => communityClient(target).activity(), [target])
  )
  const data = resource.value
  const authors = new Map<string, number>()
  for (const row of data?.rows ?? []) {
    authors.set(row.author, (authors.get(row.author) ?? 0) + 1)
  }
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{t('community.activityTitle', 'How Orca grows')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {t(
            'community.activityNote',
            'Public PR activity and merge outcomes. A merge is not a release or a maintainer approval.'
          )}
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {[
          { label: t('community.openProposals', 'Open proposals'), value: summary.total },
          { label: t('community.authors', 'Authors with open PRs'), value: summary.contributors },
          { label: t('community.areasCount', 'Inferred areas'), value: summary.areas.length }
        ].map((stat) => (
          <Card key={stat.label} size="sm">
            <CardContent>
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">{stat.label}</p>
                <p className="text-3xl font-semibold">{stat.value.toLocaleString(locale)}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      {data && <CommunityReviewChart data={data} />}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardContent>
            <div className="space-y-6">
              <h3 className="text-base font-semibold">
                {t('community.workAreas', 'Where proposals concentrate')}
              </h3>
              <Bars
                rows={summary.areas.slice(0, 6)}
                label={t('community.areaChart', 'Open PRs by inferred area')}
              />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <div className="space-y-6">
              <h3 className="text-base font-semibold">
                {t('community.recentOutcome', 'Recent submissions that merged')}
              </h3>
              {data ? (
                <>
                  <Ring
                    numerator={data.rows.filter((row) => row.merged).length}
                    denominator={data.rows.length}
                    label={t('community.mergeRate', 'Merged into source')}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('community.cohort', 'PRs created since')}{' '}
                    {new Date(data.complete ? data.since : data.cutoff).toLocaleDateString(locale)}.{' '}
                    {data.complete
                      ? t('community.completeCohort', 'Complete 90-day cohort.')
                      : t(
                          'community.partialCohort',
                          'The 2,000 most recent PRs are shown. Older submissions are not included.'
                        )}
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {resource.error ?? t('community.loadingActivity', 'Loading public activity…')}
                </p>
              )}
              {resource.error && (
                <Button variant="outline" onClick={resource.retry}>
                  {t('community.retry', 'Retry')}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
      {data && (
        <>
          <CommunitySubmissionTrend data={data} />
          <Card>
            <CardContent>
              <div className="space-y-6">
                <h3 className="text-base font-semibold">
                  {t('community.contributorsTitle', 'Most active authors in this cohort')}
                </h3>
                <Bars
                  rows={[...authors]
                    .sort(([, a], [, b]) => b - a)
                    .slice(0, 10)
                    .map(([name, count]) => ({ name: `@${name}`, count }))}
                  label={t('community.authorsChart', 'PR submissions by author')}
                />
              </div>
            </CardContent>
          </Card>
          <p className="text-xs text-muted-foreground">
            {t('community.captured', 'Captured')} {new Date(data.capturedAt).toLocaleString(locale)}{' '}
            · {Intl.DateTimeFormat(locale).resolvedOptions().timeZone}
          </p>
        </>
      )}
    </div>
  )
}
