import { useState } from 'react'
import { ExternalLink, GitBranch, Play, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type {
  CommunityCandidatePlan,
  CommunityCandidateRun
} from '../../../../shared/community-candidates'
import { communityClient } from './community-client'
export function CommunityCandidate({ target }: { target: RuntimeClientTarget }): React.JSX.Element {
  const t = useTranslate()
  const [plan, setPlan] = useState<CommunityCandidatePlan | null>(null)
  const [run, setRun] = useState<CommunityCandidateRun | null>(null)
  const [repository, setRepository] = useState('')
  const [ref, setRef] = useState('main')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const perform = async (operation: () => Promise<void>): Promise<void> => {
    if (busy) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      await operation()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="space-y-4 rounded-xl border border-border p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <GitBranch className="size-4" />
            {t('community.candidateTitle', 'Prepare a combined candidate')}
          </h3>
          <p className="mt-2 text-xs text-muted-foreground">
            {t(
              'community.candidateNote',
              'Pin the selected PRs and the official base. Build them in a disposable GitHub-hosted runner in your fork.'
            )}
          </p>
        </div>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              setPlan(await communityClient(target).prepareCandidate())
              setRun(null)
            })
          }
        >
          {t('community.preparePlan', 'Prepare source plan')}
        </Button>
      </div>
      {plan && (
        <>
          <div className="rounded-lg bg-muted/40 p-4 text-xs">
            <p className="mb-2 text-muted-foreground">
              {t('community.officialBase', 'Official source base')}
            </p>
            <code className="break-all">{plan.baseSha}</code>
            <ul className="mt-4 space-y-3">
              {plan.additions.map((pr) => (
                <li key={pr.number}>
                  <p className="font-medium">
                    #{pr.number} · {pr.title}
                  </p>
                  <code className="mt-1 block break-all text-2xs text-muted-foreground">
                    {pr.headSha}
                  </code>
                </li>
              ))}
            </ul>
          </div>
          <p className="break-all font-mono text-2xs text-muted-foreground">
            {t('community.digestAlgorithm', 'SHA-256')} {plan.digest}
          </p>
          <div className="flex flex-wrap gap-3">
            <Input
              className="min-w-48 flex-1"
              value={repository}
              onChange={(event) => setRepository(event.target.value)}
              placeholder={t('community.forkPlaceholder', 'your-account/orca')}
              aria-label={t('community.buildFork', 'Your Orca fork')}
            />
            <Input
              className="w-44"
              value={ref}
              onChange={(event) => setRef(event.target.value)}
              aria-label={t('community.workflowRef', 'Trusted workflow branch')}
            />
            <Button
              disabled={busy || !repository || !ref || !!run}
              onClick={() => setConfirm(true)}
            >
              <Play className="size-4" />
              {t('community.startCandidate', 'Review and start build')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t(
              'community.buildRequirements',
              'Your fork must contain Orca’s exact candidate workflow. Builds can use GitHub Actions minutes. No signing key or user account secret is passed to PR code.'
            )}
          </p>
        </>
      )}
      {run && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-4">
          <Badge variant="outline">{run.state}</Badge>
          {run.conclusion && <Badge variant="secondary">{run.conclusion}</Badge>}
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              void perform(async () =>
                setRun(await communityClient(target).candidateStatus(run.plan.id))
              )
            }
          >
            <RefreshCw className="size-4" />
            {t('community.refreshBuild', 'Refresh build status')}
          </Button>
          {run.state === 'completed' && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const artifact = await communityClient(target).stageArtifact(run.plan.id)
                  setRun((old) => (old ? { ...old, artifact } : old))
                })
              }
            >
              {t('community.stageArtifact', 'Download for inspection')}
            </Button>
          )}
          {run.url && (
            <Button variant="link" asChild>
              <a href={run.url} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="size-4" />
                {t('community.buildProof', 'Logs and artifacts')}
              </a>
            </Button>
          )}
        </div>
      )}
      {run?.artifact && (
        <div className="rounded-lg bg-muted p-4 text-xs">
          <p>
            {run.artifact.name} · {(run.artifact.bytes / (1024 * 1024)).toFixed(1)}{' '}
            {t('community.mibUnit', 'MiB')}
          </p>
          <code className="mt-2 block break-all">{run.artifact.digest}</code>
          <p className="mt-2">
            {run.artifact.githubDigestMatched
              ? t(
                  'community.artifactDigestMatch',
                  'Downloaded bytes matched GitHub’s artifact digest.'
                )
              : t(
                  'community.artifactOwnDigest',
                  'A local digest was recorded. GitHub supplied no digest to compare.'
                )}
          </p>
          <p className="mt-2 break-all font-mono text-2xs">{run.artifact.path}</p>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {t(
          'community.candidateTrust',
          'A completed build is not a safety verdict. Unsigned artifacts need trusted signing and compatibility checks before installation.'
        )}
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent surface="security">
          <DialogTitle>
            {t('community.confirmBuild', 'Run selected PR code in GitHub Actions?')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'community.confirmBuildDescription',
              'The runner will fetch the pinned public sources, merge them, install dependencies, check the change, and attempt a build. This may use billed Actions minutes. It creates a review branch and a pinned workflow tag in your fork. It does not install the result in Orca.'
            )}
          </DialogDescription>
          <p className="text-sm">
            {repository} · {ref}
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              {t('community.cancel', 'Cancel')}
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  if (!plan) {
                    return
                  }
                  setRun(await communityClient(target).dispatchCandidate(plan.id, repository, ref))
                  setConfirm(false)
                })
              }
            >
              {t('community.confirmStart', 'Start isolated build')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
