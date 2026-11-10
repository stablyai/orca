import React from 'react'
import { Loader2, Moon, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslate } from '@/i18n/use-translate'
import type { ReadSnapshot } from '../../../../../shared/cloud-workspaces/read-snapshot'
import { CloudGitChanges } from '../CloudGitChanges'
import { CloudWorkspaceHeader } from '../CloudWorkspaceHeader'
import { asOfParts } from './cloud-read-snapshot-format'
import { CloudReadPrLink } from './CloudReadPrLink'
import { CloudReadSessions } from './CloudReadSessions'

export type CloudReadViewState =
  | { kind: 'loading' }
  | { kind: 'ready'; snapshot: ReadSnapshot }
  | { kind: 'no_snapshot' }
  | { kind: 'not_sealed_for_key' }
  | { kind: 'not_found' }
  /** Older than a copy already shown here (a rollback); refused. */
  | { kind: 'stale' }
  /** This computer cannot hold a reader key (no OS keychain). */
  | { kind: 'unavailable'; message: string }
  | { kind: 'error'; message: string }

export type CloudReadSnapshotViewProps = {
  title: string
  state: CloudReadViewState
  now: number
  /** Wakes, then the normal open. */
  onWake: () => void
  waking: boolean
  onRetry: () => void
  retrying: boolean
  headingRef?: React.Ref<HTMLHeadingElement>
}

function LoadingBody(): React.JSX.Element {
  const t = useTranslate()
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-3">
      <span className="sr-only">
        {t('components.orcaCloud.read.loading', 'Loading the saved copy')}
      </span>
      <Skeleton className="h-9 w-full" shape="card" />
      {[0, 1].map((i) => (
        <div key={i} className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <Skeleton className="h-3 w-2/5" />
          <Skeleton className="h-3 w-4/5" shape="small" />
          <Skeleton className="h-3 w-3/5" shape="small" />
        </div>
      ))}
      <Skeleton className="h-24 w-full" shape="card" />
    </div>
  )
}

function SectionHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h3 id={id} className="text-xs font-medium text-muted-foreground">
      {children}
    </h3>
  )
}

function ReadyBody({ snapshot, now }: { snapshot: ReadSnapshot; now: number }) {
  const t = useTranslate()
  const git = snapshot.git
  return (
    <div className="flex flex-col gap-5">
      {snapshot.pr ? <CloudReadPrLink pr={snapshot.pr} /> : null}
      <section aria-labelledby="cloud-read-agents" className="flex flex-col gap-2">
        <SectionHeading id="cloud-read-agents">
          {t('components.orcaCloud.read.agents', 'Agents')}
        </SectionHeading>
        <CloudReadSessions sessions={snapshot.sessions} />
      </section>
      <section aria-labelledby="cloud-read-changes" className="flex flex-col gap-2">
        <SectionHeading id="cloud-read-changes">
          {t('components.orcaCloud.read.changes', 'Changes')}
        </SectionHeading>
        {git ? (
          <CloudGitChanges
            now={now}
            data={{
              branch: git.branch,
              changes: git.changes,
              changeCount: git.changeCount,
              lineTotals:
                git.added !== null && git.removed !== null
                  ? { added: git.added, removed: git.removed }
                  : null,
              commits: git.commits.map((commit) => ({
                sha: commit.id,
                subject: commit.subject,
                at: commit.at
              }))
            }}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('components.orcaCloud.offline.noGit', 'No source control state was saved.')}
          </p>
        )}
      </section>
    </div>
  )
}

/**
 * A sleeping workspace, read from the copy it saved when it went to sleep (sealed to this
 * computer's reader key). Read-only; the only way forward is the explicit "Wake to continue".
 */
export function CloudReadSnapshotView(props: CloudReadSnapshotViewProps): React.JSX.Element {
  const t = useTranslate()
  const { state, now } = props
  const asOf = state.kind === 'ready' ? asOfParts(state.snapshot.capturedAt, now) : null
  return (
    <section
      className="flex min-h-0 w-full flex-col gap-5"
      aria-label={t('components.orcaCloud.read.region', 'Asleep workspace (read-only)')}
      data-cloud-read-view={state.kind}
    >
      <CloudWorkspaceHeader
        icon={Moon}
        title={props.title}
        state="sleeping"
        stateLine={
          asOf
            ? t('components.orcaCloud.read.asOf', 'Asleep · As of {{when}}', {
                when: asOf.relative
              })
            : t('components.orcaCloud.read.asleep', 'Asleep')
        }
        stateTitle={asOf?.absolute}
        note={
          state.kind === 'ready'
            ? t('components.orcaCloud.read.note', 'Read-only copy saved when it went to sleep.')
            : undefined
        }
        headingRef={props.headingRef}
        action={
          <Button
            size="sm"
            onClick={props.waking ? undefined : props.onWake}
            aria-disabled={props.waking || undefined}
            aria-busy={props.waking || undefined}
          >
            {props.waking ? <Loader2 className="motion-safe:animate-spin" aria-hidden /> : <Play />}
            {t('components.orcaCloud.read.wakeToContinue', 'Wake to continue')}
          </Button>
        }
      />
      {state.kind === 'loading' ? <LoadingBody /> : null}
      {state.kind === 'ready' ? <ReadyBody snapshot={state.snapshot} now={now} /> : null}
      {state.kind === 'no_snapshot' ? (
        <InlineError
          tone="neutral"
          title={t(
            'components.orcaCloud.read.empty',
            'Nothing saved yet. Orca saves a read-only copy each time this workspace goes to sleep.'
          )}
        />
      ) : null}
      {state.kind === 'not_sealed_for_key' ? (
        <InlineError
          tone="neutral"
          title={t(
            'components.orcaCloud.read.notSealedForKey',
            'This device was added after the workspace went to sleep. Wake it once to read it here.'
          )}
        />
      ) : null}
      {state.kind === 'stale' ? (
        <InlineError
          tone="neutral"
          title={t(
            'components.orcaCloud.read.stale',
            'Orca Cloud returned an older copy than the one already shown here, so it is hidden. Wake the workspace to see it as it is now.'
          )}
        />
      ) : null}
      {state.kind === 'not_found' ? (
        <InlineError
          tone="neutral"
          title={t(
            'auto.components.cloudWorkspaces.errorNotFound',
            'This workspace is private, archived or no longer exists.'
          )}
        />
      ) : null}
      {state.kind === 'unavailable' ? (
        <InlineError
          tone="neutral"
          title={t(
            'components.orcaCloud.read.unavailable',
            'Reading a sleeping workspace needs the OS keychain on this computer.'
          )}
        />
      ) : null}
      {state.kind === 'error' ? (
        <InlineError
          title={state.message}
          retryLabel={t('components.orcaCloud.read.tryAgain', 'Try again')}
          retrying={props.retrying}
          onRetry={props.onRetry}
        />
      ) : null}
    </section>
  )
}
