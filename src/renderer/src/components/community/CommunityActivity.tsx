import { useCallback, useState } from 'react'
import { ArrowRight, GitMerge, GitPullRequest, Package } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { communityClient } from './community-client'
import { useCommunityResource } from './use-community-resource'
import { CommunityReviewChart } from './CommunityReviewChart'
import { CommunityContributionChart } from './CommunityContributionChart'
import { CommunitySubmissionTrend } from './CommunitySubmissionTrend'
import { CommunityOutcomeFlow } from './CommunityOutcomeFlow'
import { CommunityApprovalTrend } from './CommunityApprovalTrend'
import { communityActivityGroups } from './community-activity-series'
import type { CommunityGroupMode } from './community-activity-series'
import { useCommunityNavigation } from './community-navigation'

export function CommunityActivity({ target }: { target: RuntimeClientTarget }): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const [mode, setMode] = useState<CommunityGroupMode>('affiliation')
  const resource = useCommunityResource(
    useCallback(() => communityClient(target).activity(), [target])
  )
  const data = resource.value
  const groups = data ? communityActivityGroups(data, mode) : []
  const community = groups.find((group) => group.id === 'community')?.rows ?? []
  const human = groups
    .filter((group) => group.id === 'community' || group.id === 'team')
    .flatMap((group) => group.rows)
  const rate = (numerator: number, denominator: number): string =>
    denominator
      ? new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(
          numerator / denominator
        )
      : '—'
  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-2xl font-semibold">
          {t('community.activityTitle', 'Community activity')}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {t(
            'community.activityDescription',
            'Compare who proposes changes, whose work is reviewed, and what is merged.'
          )}
        </p>
      </header>
      {resource.error && (
        <div role="alert" className="space-y-3 rounded-xl border border-border p-4">
          <p className="text-sm">{resource.error}</p>
          <Button variant="outline" onClick={resource.retry}>
            {t('community.retry', 'Retry')}
          </Button>
        </div>
      )}
      {!data ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('community.loadingActivity', 'Loading public activity…')}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/50 p-4 text-xs text-muted-foreground">
            <span>
              {new Date(data.complete ? data.since : data.cutoff).toLocaleDateString(locale)} —{' '}
              {new Date(data.capturedAt).toLocaleDateString(locale)} ·{' '}
              {data.complete
                ? t('community.completeCohort', 'Complete 90-day cohort.')
                : t(
                    'community.partialCohort',
                    'The 2,000 most recent PRs are shown. Older submissions are not included.'
                  )}
            </span>
            <details>
              <summary className="cursor-pointer">
                {t('community.groupsMethod', 'Groups and method')}
              </summary>
              <p className="mt-3 max-w-3xl leading-relaxed">
                {t(
                  'community.activityMethod',
                  'Public GitHub affiliation and verified maintainer roles are separate groupings. Automation and unclassified authors stay visible. All panels use the same submission cohort and capture date. Review rates exclude missing review history. A merge does not establish approval or official release inclusion.'
                )}
              </p>
            </details>
          </div>
          <dl className="grid grid-cols-3 divide-x divide-border border-b border-border pb-6 max-sm:grid-cols-1 max-sm:gap-4 max-sm:divide-x-0">
            {[
              {
                label: t('community.submittedPRs', 'submitted PRs'),
                value: data.rows.length.toLocaleString(locale),
                note: t('community.observedCohort', 'In this captured cohort')
              },
              {
                label: t('community.communityAuthored', 'Community-authored'),
                value: rate(community.length, data.rows.length),
                note: `${community.length} / ${data.rows.length}`
              },
              {
                label: t('community.humanPRsMerged', 'Human PRs merged'),
                value: rate(human.filter((row) => row.merged).length, human.length),
                note: `${human.filter((row) => row.merged).length} / ${human.length}`
              }
            ].map((stat) => (
              <div key={stat.label} className="px-5 first:pl-0 max-sm:px-0">
                <dd className="text-3xl font-semibold">{stat.value}</dd>
                <dt className="mt-2 text-sm font-medium">{stat.label}</dt>
                <p className="mt-1 text-xs text-muted-foreground">{stat.note}</p>
              </div>
            ))}
          </dl>
          <div className="grid items-start gap-5 xl:grid-cols-[2fr_1fr]">
            <CommunityReviewChart data={data} mode={mode} onModeChange={setMode} />
            <CommunityContributionChart data={data} mode={mode} />
          </div>
          <div className="grid items-start gap-5 xl:grid-cols-[2fr_1fr]">
            <CommunitySubmissionTrend data={data} mode={mode} />
            <section className="space-y-6 rounded-xl border border-border bg-card p-6 text-card-foreground">
              <div>
                <p className="text-2xs text-muted-foreground">
                  04 · {t('community.proposalToRelease', 'From proposal to release')}
                </p>
                <h3 className="mt-2 text-base font-semibold">
                  {t('community.whenCanIUse', 'When can I use a change?')}
                </h3>
              </div>
              {[
                {
                  icon: GitPullRequest,
                  title: t('community.proposedStage', '1. Proposed'),
                  note: t('community.proposedNote', 'Explore the open PR')
                },
                {
                  icon: GitMerge,
                  title: t('community.mergedStage', '2. Merged into source'),
                  note: t('community.mergedNote', 'Wait for a published release')
                },
                {
                  icon: Package,
                  title: t('community.releasedStage', '3. Released officially'),
                  note: t('community.releasedNote', 'Find its version in Changelog')
                }
              ].map((stage) => (
                <div key={stage.title} className="flex gap-3">
                  <stage.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">{stage.title}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{stage.note}</p>
                  </div>
                </div>
              ))}
              <Button
                variant="outline"
                className="w-full"
                onClick={() => useCommunityNavigation.getState().setSection('changelog')}
              >
                {t('community.openChangelog', 'Open Changelog')}
                <ArrowRight className="size-4" />
              </Button>
            </section>
          </div>
          <CommunityOutcomeFlow data={data} mode={mode} />
          <div className="grid items-start gap-5 xl:grid-cols-[2fr_1fr]">
            <CommunityApprovalTrend data={data} mode={mode} />
            <section className="space-y-5 rounded-xl border border-border bg-card p-6 text-card-foreground">
              <h3 className="text-base font-semibold">
                {t('community.everyMeasureSource', 'Every measure needs its source.')}
              </h3>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t(
                  'community.captureScope',
                  'These charts describe the captured PRs. Newer submissions have had less time to receive reviews or merge.'
                )}
              </p>
              <dl className="space-y-4 text-xs">
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">
                    {t('community.maintainerRoster', 'Maintainer roster')}
                  </dt>
                  <dd>
                    {data.maintainers === null
                      ? t('community.unavailable', 'Unavailable')
                      : data.maintainers.length}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">
                    {t('community.reviewCoverage', 'Complete review history')}
                  </dt>
                  <dd>
                    {data.rows.filter((row) => row.reviewed !== null).length}/{data.rows.length}
                  </dd>
                </div>
              </dl>
              {data.roleError && (
                <p role="status" className="text-xs leading-relaxed text-muted-foreground">
                  {data.roleError}
                </p>
              )}
              <Button variant="outline" size="sm" onClick={resource.retry}>
                {t('community.reloadActivity', 'Reload data')}
              </Button>
              <a
                className="block text-xs underline underline-offset-4"
                href="https://github.com/stablyai/orca/pulls"
                target="_blank"
                rel="noopener noreferrer"
              >
                {t('community.browseSourcePRs', 'Browse source PRs on GitHub')}
              </a>
            </section>
          </div>
          <p className="text-2xs text-muted-foreground">
            {t('community.captured', 'Captured')} {new Date(data.capturedAt).toLocaleString(locale)}{' '}
            · {Intl.DateTimeFormat(locale).resolvedOptions().timeZone}
          </p>
        </>
      )}
    </div>
  )
}
