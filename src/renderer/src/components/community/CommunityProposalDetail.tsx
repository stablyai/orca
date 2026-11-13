import { CommunitySourceDiff } from './CommunitySourceDiff'
import { getCustomBuildInfo } from '../../../../shared/custom-build'
import { CommunityFeatureHistory } from './CommunityFeatureHistory'
import { useEffect, useState } from 'react'
import { ArrowLeft, Bookmark, ExternalLink, GitPullRequest, Plus, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { CommunityDetail } from '../../../../shared/community-operations'
import type {
  CommunityFeatureAction,
  CommunityFeaturesSnapshot
} from '../../../../shared/community-features'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { communityClient } from './community-client'
import { CommunityImages } from './CommunityImages'
import { CommunityFeatureChat } from './CommunityFeatureChat'
export function CommunityProposalDetail({
  number,
  target,
  onBack,
  mutate
}: {
  number: number
  target: RuntimeClientTarget
  onBack: () => void
  mutate: (action: CommunityFeatureAction) => Promise<CommunityFeaturesSnapshot>
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const [detail, setDetail] = useState<CommunityDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState('preview')
  const [revision, setRevision] = useState(0)
  const installed = getCustomBuildInfo()?.changes.find(
    (change) => change.pullRequest?.number === number
  )?.pullRequest
  const included = !!installed && installed.headSha === detail?.pr.headSha
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let current = true
    setDetail(null)
    setError(null)
    void communityClient(target)
      .detail(number, revision > 0)
      .then(async (result) => {
        if (!current) {
          return
        }
        setDetail(result)
        await mutate({ action: 'visit', number, headSha: result.pr.headSha })
        const history = await communityClient(target).history(number)
        if (current) {
          setDetail((old) => (old ? { ...old, history } : old))
        }
      })
      .catch((cause) => {
        if (current) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      })
    return () => {
      current = false
    }
  }, [number, target, revision, mutate])
  const action = async (action: CommunityFeatureAction): Promise<boolean> => {
    if (busy) {
      return false
    }
    setBusy(true)
    try {
      const personal = await mutate(action)
      setDetail((old) => (old ? { ...old, feature: personal.features[number] ?? null } : old))
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft className="size-4" />
        {t('community.back', 'Back to proposals')}
      </Button>
      {error && (
        <div role="alert" className="space-y-2 rounded-lg border border-border p-4 text-sm">
          <p>{error}</p>
          <Button variant="outline" size="sm" onClick={() => setRevision((v) => v + 1)}>
            {t('community.retry', 'Retry')}
          </Button>
        </div>
      )}
      {detail ? (
        <>
          {detail.warnings.map((warning) => (
            <p key={warning} role="status" className="rounded-lg bg-muted p-3 text-xs">
              {warning}
            </p>
          ))}
          <header>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Badge variant="outline">
                <GitPullRequest className="size-3" />#{number}
              </Badge>
              <Badge variant="secondary">
                {detail.pr.state === 'merged'
                  ? t('community.mergedSource', 'Merged into source')
                  : detail.pr.state === 'closed'
                    ? t('community.closed', 'Closed')
                    : t('community.unmerged', 'Not merged into official Orca')}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {detail.pr.area} · @{detail.pr.author}
              </span>
            </div>
            <h2 className="text-2xl font-semibold leading-tight">{detail.pr.title}</h2>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                onClick={() =>
                  void action({
                    action: detail.feature?.selectedAt ? 'unselect' : 'select',
                    number
                  })
                }
                disabled={busy || included}
              >
                <Plus className="size-4" />
                {included
                  ? t('community.alreadyIncluded', 'Included in this build')
                  : detail.feature?.selectedAt
                    ? t('community.removeSelection', 'Remove from selected additions')
                    : t('community.selectCustom', 'Select for Custom')}
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  void action({ action: detail.feature?.savedAt ? 'unsave' : 'save', number })
                }
                disabled={busy}
                aria-pressed={!!detail.feature?.savedAt}
              >
                <Bookmark className={`size-4 ${detail.feature?.savedAt ? 'fill-current' : ''}`} />
                {detail.feature?.savedAt
                  ? t('community.saved', 'Saved')
                  : t('community.save', 'Save proposal')}
              </Button>
              <Button variant="outline" asChild>
                <a href={detail.pr.url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="size-4" />
                  {t('community.sourceProvider', 'GitHub')}
                </a>
              </Button>
              <Button variant="ghost" onClick={() => setRevision((v) => v + 1)}>
                <RefreshCw className="size-4" />
                {t('community.refreshEvidence', 'Refresh evidence')}
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {t(
                'community.selectedNotInstalled',
                'Selection adds this PR to your plan. It does not install code.'
              )}
            </p>
          </header>
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList variant="line" className="w-full justify-start">
              <TabsTrigger className="flex-none" value="preview">
                {t('community.preview', 'Preview')}
              </TabsTrigger>
              <TabsTrigger className="flex-none" value="inspection">
                {t('community.inspection', 'Inspection')}
              </TabsTrigger>
              <TabsTrigger className="flex-none" value="chat">
                {t('community.chat', 'AI conversation')}
              </TabsTrigger>
              <TabsTrigger className="flex-none" value="history">
                {t('community.history', 'History')}
              </TabsTrigger>
            </TabsList>
          </Tabs>
          {tab === 'preview' && (
            <>
              <CommunityImages images={detail.pr.imageUrls} title={detail.pr.title} />
              <section>
                <h3 className="mb-3 text-base font-semibold">
                  {t('community.authorDescription', 'From the author')}
                </h3>
                <p className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-sm leading-relaxed scrollbar-sleek">
                  {detail.body ||
                    t('community.noDescription', 'The author has not added a description.')}
                </p>
              </section>
            </>
          )}
          {tab === 'inspection' && (
            <div className="space-y-5">
              <div className="rounded-xl border border-border p-5">
                <h3 className="text-base font-semibold">
                  {t('community.sourceVersion', 'Evidence for this source version')}
                </h3>
                <code className="mt-2 block break-all text-xs">{detail.pr.headSha}</code>
                <p className="mt-2 text-xs text-muted-foreground">
                  {t('community.observed', 'Observed')}{' '}
                  {new Date(detail.observedAt).toLocaleString(locale)} ·{' '}
                  {Intl.DateTimeFormat(locale).resolvedOptions().timeZone}
                </p>
                <p className="mt-3 text-sm">
                  {t(
                    'community.notSecurityScan',
                    'GitHub checks and reviews are evidence. They are not a malware scan or a guarantee of safety.'
                  )}
                </p>
              </div>
              <div className="grid gap-5 lg:grid-cols-2">
                <section className="rounded-xl border border-border p-5">
                  <h3 className="mb-3 text-sm font-semibold">
                    {t('community.checks', 'GitHub checks')}
                  </h3>
                  {detail.checksObserved && !detail.checks.length && (
                    <p className="text-sm text-muted-foreground">
                      {t('community.noChecks', 'No checks were returned for this head.')}
                    </p>
                  )}
                  <ul className="divide-y divide-border">
                    {detail.checks.map((check) => (
                      <li
                        key={`${check.name}-${check.url}`}
                        className="flex justify-between gap-4 py-3 text-xs"
                      >
                        <span>
                          {check.url ? (
                            <a
                              href={check.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="underline"
                            >
                              {check.name}
                            </a>
                          ) : (
                            check.name
                          )}
                        </span>
                        <Badge variant="outline">{check.state}</Badge>
                      </li>
                    ))}
                  </ul>
                  {!detail.checksComplete && (
                    <p className="mt-3 text-xs text-muted-foreground">
                      {t(
                        'community.checksPartial',
                        'More checks exist on GitHub. This view is incomplete.'
                      )}
                    </p>
                  )}
                </section>
                <section className="rounded-xl border border-border p-5">
                  <h3 className="mb-3 text-sm font-semibold">
                    {t('community.reviews', 'Code reviews')}
                  </h3>
                  <ul className="divide-y divide-border">
                    {detail.reviews.map((review) => (
                      <li key={review.url} className="space-y-1 py-3 text-xs">
                        <a
                          className="underline"
                          href={review.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          @{review.author} · {review.state}
                        </a>
                        <p className="text-muted-foreground">
                          {review.commit === detail.pr.headSha
                            ? t('community.currentHead', 'Current head')
                            : t('community.olderHead', 'Earlier source version')}
                        </p>
                      </li>
                    ))}
                  </ul>
                  {detail.reviewsObserved && !detail.reviews.length && (
                    <p className="text-xs text-muted-foreground">
                      {t('community.noReviews', 'No submitted reviews were returned.')}
                    </p>
                  )}
                  {!detail.reviewsComplete && (
                    <p className="mt-3 text-xs text-muted-foreground">
                      {t(
                        'community.reviewsPartial',
                        'The first 100 reviews are shown. Open GitHub for the full history.'
                      )}
                    </p>
                  )}
                </section>
              </div>
              <CommunitySourceDiff diff={detail.diff} />
              <Button variant="outline" onClick={() => setTab('chat')}>
                {t('community.askAI', 'Ask AI to investigate or request more evidence')}
              </Button>
            </div>
          )}
          {tab === 'chat' && (
            <CommunityFeatureChat
              detail={detail}
              onLink={async (chat) => {
                if (!(await action({ action: 'link-chat', number, chat }))) {
                  throw new Error(
                    'The conversation started, but its feature link could not be saved. Retry saving the link.'
                  )
                }
              }}
            />
          )}
          {tab === 'history' && <CommunityFeatureHistory detail={detail} target={target} />}
        </>
      ) : (
        !error && (
          <p role="status" className="text-sm text-muted-foreground">
            {t('community.loadingEvidence', 'Loading PR evidence…')}
          </p>
        )
      )}
    </div>
  )
}
