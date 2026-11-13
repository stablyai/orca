import React from 'react'
import { Cloud, Loader2, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { Skeleton } from '@/components/ui/skeleton'
import { formatElapsedTime } from '@/components/worktree-creation/worktree-creation-clock'
import { useNow } from '@/hooks/use-now'
import { useTranslate } from '@/i18n/use-translate'
import { isLinuxUserAgent } from '@/app-shell/platform/user-agent-platform'
import { WAKE_SLOW_S } from '../CloudWakingOverlay'
import type { ReadSnapshot } from '../../../../../shared/cloud-workspaces/read-snapshot'
import { CloudGitChanges } from '../CloudGitChanges'
import { CloudWorkspaceHeader } from '../CloudWorkspaceHeader'
import { asOfParts } from './cloud-read-snapshot-format'
import { CloudReadPrLink } from './CloudReadPrLink'
import { CloudReadSessions } from './CloudReadSessions'
import { CloudSleepCopyFailed, CloudSleepCopySaving } from '../offline/CloudSleepCopyState'

export type CloudReadViewState =
  | { kind: 'loading' }
  | { kind: 'ready'; snapshot: ReadSnapshot }
  | { kind: 'no_snapshot' }
  | { kind: 'not_sealed_for_key' }
  | { kind: 'not_found' }
  /** Older than a copy already shown here (a rollback); refused. */
  | { kind: 'stale' }
  /** The workspace did not sign it (forged, or unsigned after a signer was pinned). */
  | { kind: 'unverified' }
  /** Signed by a different key than the one pinned (e.g. its sandbox was rebuilt). */
  | { kind: 'signer_changed' }
  /** This computer cannot hold a reader key (no OS keychain). */
  | { kind: 'unavailable'; message: string }
  | { kind: 'error'; message: string }

export type CloudReadSnapshotViewProps = {
  title: string
  state: CloudReadViewState
  now: number
  /** Wakes, then the normal open (and the live workspace replaces this view). */
  onWake: () => void
  /** A wake started here: in flight since `startedAt`, or failed. */
  wake?: CloudReadWake | null
  onRetry: () => void
  retrying: boolean
  headingRef?: React.Ref<HTMLHeadingElement>
  /** Linux names the keyring to set up; defaults to this renderer's platform. */
  linux?: boolean
  /**
   * SLEEP-IN-PROGRESS (paired): Sleep was pressed here and its sealed copy is still being saved, or
   * never arrived. Either replaces the copy and every empty state; saving has no Wake yet.
   */
  copySave?: 'saving' | 'failed' | null
}

export type CloudReadWake =
  | { phase: 'waking'; startedAt: number }
  /** `message`: why, when the open flow said (e.g. the team's running limit). */
  | { phase: 'failed'; message?: string; unknownServerError?: boolean }

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
  const waking = props.wake?.phase === 'waking' ? props.wake : null
  const failed = props.wake?.phase === 'failed' ? props.wake : null
  const clock = useNow(1_000, waking !== null)
  const elapsedMs = waking ? Math.max(0, clock - waking.startedAt) : 0
  const slow = waking !== null && elapsedMs >= WAKE_SLOW_S * 1_000
  const lifecycle = waking
    ? t('orcaCloudWorkspace.state.waking', 'Waking')
    : t('components.orcaCloud.read.asleep', 'Asleep')
  const linux = props.linux ?? isLinuxUserAgent()
  const saving = props.copySave === 'saving'
  const copyFailed = !saving && props.copySave === 'failed'
  // The copy's own lines (and its empty states) only once a copy is known to be in.
  const body = saving || copyFailed ? null : state.kind
  return (
    <section
      className="flex min-h-0 w-full flex-col gap-5"
      aria-label={t('components.orcaCloud.read.region', 'Asleep workspace (read-only)')}
      data-cloud-read-view={state.kind}
    >
      <CloudWorkspaceHeader
        icon={Cloud}
        title={props.title}
        state={waking ? 'waking' : 'sleeping'}
        stateLine={
          saving
            ? t(
                'components.orcaCloud.offline.copySaving.state',
                'Going to sleep · Saving a read-only copy…'
              )
            : asOf && !copyFailed
              ? t('components.orcaCloud.read.stateAsOf', '{{state}} · As of {{when}}', {
                  state: lifecycle,
                  when: asOf.relative
                })
              : lifecycle
        }
        stateTitle={asOf?.absolute}
        note={
          body === 'ready'
            ? t('components.orcaCloud.read.note', 'Read-only copy saved when it went to sleep.')
            : undefined
        }
        headingRef={props.headingRef}
        action={
          // Still saving its copy: not asleep yet, so no Wake to continue beside the spinner.
          saving ? undefined : (
            <Button
              size="sm"
              onClick={waking ? undefined : props.onWake}
              aria-disabled={waking ? true : undefined}
              aria-busy={waking ? true : undefined}
              className="aria-disabled:pointer-events-none"
            >
              {waking ? <Loader2 className="motion-safe:animate-spin" aria-hidden /> : <Play />}
              {waking ? (
                <span className="tabular-nums">
                  {t('components.orcaCloud.read.wakingElapsed', 'Waking… {{elapsed}}', {
                    elapsed: formatElapsedTime(elapsedMs)
                  })}
                </span>
              ) : (
                t('components.orcaCloud.read.wakeToContinue', 'Wake to continue')
              )}
            </Button>
          )
        }
      />
      {/* Announced once when the wake crosses the slow mark (the text changes only then). */}
      <p role="status" className={slow ? '-mt-3 pl-6 text-xs text-muted-foreground' : 'sr-only'}>
        {slow
          ? t(
              'orcaCloudWorkspace.overlay.slow',
              'Taking longer than usual. Your files and chats are safe.'
            )
          : ''}
      </p>
      {failed?.unknownServerError ? (
        // The shared copy for an unexplained server failure (also the remote desktop's).
        <InlineError
          title={t('components.cloudRemoteDesktop.wakeFailedTitle', 'Couldn’t wake the sandbox.')}
          detail={t('components.cloudRemoteDesktop.wakeFailedDetail', 'Your files are safe.')}
          retryLabel={t('orcaCloudWorkspace.overlay.tryAgain', 'Try again')}
          onRetry={props.onWake}
        />
      ) : failed ? (
        <InlineError
          title={t('orcaCloudWorkspace.overlay.failedTitle', 'Couldn’t wake {{name}}', {
            name: props.title
          })}
          detail={
            <>
              {t('orcaCloudWorkspace.overlay.failedDetail', 'Your files and chats are saved.')}
              {failed.message ? <span className="block">{failed.message}</span> : null}
            </>
          }
          retryLabel={t('orcaCloudWorkspace.overlay.tryAgain', 'Try again')}
          onRetry={props.onWake}
        />
      ) : null}
      {saving ? <CloudSleepCopySaving /> : null}
      {copyFailed ? <CloudSleepCopyFailed /> : null}
      {body === 'loading' ? <LoadingBody /> : null}
      {state.kind === 'ready' && body === 'ready' ? (
        <ReadyBody snapshot={state.snapshot} now={now} />
      ) : null}
      {body === 'no_snapshot' ? (
        <InlineError
          tone="neutral"
          title={t(
            'components.orcaCloud.read.empty',
            'Nothing saved yet. Orca saves a read-only copy each time this workspace goes to sleep.'
          )}
        />
      ) : null}
      {body === 'not_sealed_for_key' ? (
        <InlineError
          tone="neutral"
          title={t(
            'components.orcaCloud.read.notSealedForKey',
            'This device was added after the workspace went to sleep. Wake it once to read it here.'
          )}
        />
      ) : null}
      {body === 'stale' ? (
        <InlineError
          tone="neutral"
          title={t(
            'components.orcaCloud.read.staleCopy',
            'Orca Cloud sent an older copy than the one you last saw, so it isn’t shown. Wake the workspace to see it as it is now.'
          )}
        />
      ) : null}
      {body === 'unverified' ? (
        <InlineError
          tone="neutral"
          title={t(
            'components.orcaCloud.read.unverified',
            'The saved copy of this workspace couldn’t be verified, so it isn’t shown. Wake the workspace to see it as it is now.'
          )}
        />
      ) : null}
      {body === 'signer_changed' ? (
        <InlineError
          tone="neutral"
          title={t(
            'components.orcaCloud.read.signerChangedHidden',
            'The saved copy of this workspace is signed by a different key than before, so it isn’t shown. Wake the workspace to see it as it is now.'
          )}
        />
      ) : null}
      {body === 'not_found' ? (
        <InlineError
          tone="neutral"
          title={t(
            'auto.components.cloudWorkspaces.errorNotFound',
            'This workspace is private, archived or no longer exists.'
          )}
        />
      ) : null}
      {body === 'unavailable' ? (
        <InlineError
          tone="neutral"
          title={t(
            'components.orcaCloud.read.keychainUnavailable',
            'Orca can’t open the saved copy because this computer’s keychain isn’t available. Wake the workspace to see it.'
          )}
          detail={
            linux
              ? t(
                  'components.orcaCloud.read.keychainLinux',
                  'Or set up a keyring (like GNOME Keyring) and reopen Orca.'
                )
              : undefined
          }
        />
      ) : null}
      {state.kind === 'error' && body === 'error' ? (
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
