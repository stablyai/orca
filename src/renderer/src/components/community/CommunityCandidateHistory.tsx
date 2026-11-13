import { communityRequestResult } from './community-request-result'
import { useCallback, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type {
  CommunityCandidateHistoryPage,
  CommunityCandidateRun
} from '../../../../shared/community-candidates'
import { communityClient } from './community-client'
import { useCommunityResource } from './use-community-resource'
export function CommunityCandidateHistory({
  target
}: {
  target: RuntimeClientTarget
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const resource = useCommunityResource(
    useCallback(() => communityClient(target).candidateHistory(), [target])
  )
  const [extra, setExtra] = useState<CommunityCandidateHistoryPage['rows']>([])
  const [next, setNext] = useState<number | null | undefined>()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [updated, setUpdated] = useState<Record<string, CommunityCandidateRun>>({})
  const perform = async (action: () => Promise<void>): Promise<void> => {
    if (busy) {
      return
    }
    setBusy(true)
    setError(null)
    const result = await communityRequestResult(async () => {
      await action()
    })
    if (!result.ok) {
      setError(result.message)
    }
    setBusy(false)
  }
  const offset = next === undefined ? resource.value?.nextOffset : next
  return (
    <section className="space-y-4">
      <h3 className="text-base font-semibold">
        {t('community.buildHistory', 'Candidate history')}
      </h3>
      {[...(resource.value?.rows ?? []), ...extra].map(({ plan, run: saved }) => {
        const run = updated[plan.id] ?? saved
        return (
          <article key={plan.id} className="space-y-3 rounded-xl border border-border p-4">
            <div className="flex flex-wrap justify-between gap-3">
              <p className="text-sm font-medium">
                {plan.additions.length
                  ? plan.additions.map((pr) => `#${pr.number}`).join(' · ')
                  : t('community.baseUpdate', 'Official source update')}
              </p>
              <Badge variant="outline">
                {run?.conclusion ?? run?.state ?? t('community.sourcePlan', 'Source plan')}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {new Date(plan.createdAt).toLocaleString(locale)} · {plan.includedChanges.length}{' '}
              {t('community.preservedChanges', 'existing changes preserved in the source plan')}
            </p>
            <code className="block break-all text-2xs text-muted-foreground">
              {t('community.digestAlgorithm', 'SHA-256')} {plan.digest}
            </code>
            {run?.artifact && (
              <div className="space-y-1 text-xs">
                <p>
                  {run.artifact.name} · {new Date(run.artifact.stagedAt).toLocaleString(locale)}
                </p>
                <code className="block break-all">{run.artifact.digest}</code>
                <p className="break-all font-mono text-2xs text-muted-foreground">
                  {run.artifact.path}
                </p>
              </div>
            )}
            <div className="flex flex-wrap gap-3">
              {run?.url && (
                <Button variant="link" asChild>
                  <a href={run.url} target="_blank" rel="noopener noreferrer">
                    {t('community.buildProof', 'Logs and artifacts')}
                  </a>
                </Button>
              )}
              {run && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      const result = await communityClient(target).candidateStatus(plan.id)
                      setUpdated((previous) => ({ ...previous, [plan.id]: result }))
                    })
                  }
                >
                  {t('community.refreshBuild', 'Refresh build status')}
                </Button>
              )}
              {run?.state === 'completed' && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      const artifact = await communityClient(target).stageArtifact(plan.id)
                      setUpdated((previous) => ({ ...previous, [plan.id]: { ...run, artifact } }))
                    })
                  }
                >
                  {t('community.stageArtifact', 'Download for inspection')}
                </Button>
              )}
            </div>
          </article>
        )
      })}
      {offset !== null && offset !== undefined && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              const page = await communityClient(target).candidateHistory(offset)
              setExtra((previous) => [...previous, ...page.rows])
              setNext(page.nextOffset)
            })
          }
        >
          {t('community.moreHistory', 'Load more history')}
        </Button>
      )}
      {(resource.error || error) && (
        <p role="alert" className="text-sm text-destructive">
          {error ?? resource.error}
        </p>
      )}
    </section>
  )
}
