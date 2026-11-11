import React from 'react'
import { Loader2, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useNow } from '@/hooks/use-now'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import { formatElapsedTime } from '@/components/worktree-creation/worktree-creation-clock'
import { wakeCloudWorkspace } from '../cloud-workspace-actions'
import { useCloudOfflineData } from './use-cloud-offline-data'
import type { CloudOfflineSnapshot } from '../../../../../shared/hosted-sandbox/cloud-workspace-offline-api'

const RELATIVE_LIMIT_MS = 30 * 24 * 60 * 60 * 1000

/** The snapshot names a change's status in words ("modified", "untracked"); the explorer's letter. */
export function changeStatusLetter(status: string): string {
  const word = status.trim().toLowerCase()
  if (word === 'untracked' || word === '?' || word === '??') {
    return 'U'
  }
  return (word[0] ?? '?').toUpperCase()
}

/** "47s ago" for anything recent; a date beyond about a month ("5,362 days ago" is unreadable). */
export function formatWhen(at: number, now: number, locale: string, t: Translate): string {
  const ago = Math.max(0, now - at)
  return ago < RELATIVE_LIMIT_MS
    ? t('orcaCloudWorkspace.ago', '{{ago}} ago', { ago: formatElapsedTime(ago) })
    : new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(at)
}

/**
 * The Files tab of an Orca Cloud workspace that is asleep (RA-10). There is no file tree without
 * the VM, so instead of a read error and Retry: what had changed when it went to sleep (from its
 * read snapshot or this computer's cache) and its recent commits, read-only, then Wake for the
 * full view. With no snapshot, a neutral note and Wake; while waking, a note that files follow.
 */
export function CloudAsleepFilesPanel({
  workspaceId,
  waking = false,
  archived = false
}: {
  workspaceId: string
  /** Opening an asleep workspace wakes it: the files arrive when it is up, nothing to press. */
  waking?: boolean
  /**
   * Archived, not asleep (DS-h): the copy says "archived", and there is no Wake here, since the
   * archived view beside it already has Unarchive as its one action.
   */
  archived?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const { snapshot } = useCloudOfflineData(workspaceId, true)
  const now = useNow(30_000)
  const git = snapshot?.git ?? null
  const wake = archived ? null : waking ? (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground" role="status">
      <Loader2 className="size-3 motion-safe:animate-spin" aria-hidden="true" />
      {t('orcaCloudWorkspace.files.waking', 'Waking… the files show when it’s up.')}
    </span>
  ) : (
    <Button size="xs" variant="outline" onClick={() => void wakeCloudWorkspace(workspaceId)}>
      <Play />
      {t('orcaCloudWorkspace.wake', 'Wake')}
    </Button>
  )
  return (
    <div
      className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto px-3 py-3 text-xs scrollbar-sleek"
      data-cloud-asleep-files={git ? 'snapshot' : 'none'}
    >
      {git ? (
        <>
          <SavedChanges git={git} at={snapshot?.capturedAt ?? null} now={now} archived={archived} />
          <RecentCommits git={git} now={now} />
          <div className="flex flex-col items-start gap-2 border-t border-border/60 pt-3 text-muted-foreground">
            <p>
              {archived
                ? t(
                    'orcaCloudWorkspace.files.unarchiveForAll',
                    'Unarchive the workspace to browse all its files.'
                  )
                : t(
                    'orcaCloudWorkspace.files.wakeForAll',
                    'Wake the workspace to browse all its files.'
                  )}
            </p>
            {wake}
          </div>
        </>
      ) : (
        <div className="flex flex-col items-start gap-2 text-muted-foreground">
          <p>
            {archived
              ? t(
                  'orcaCloudWorkspace.files.archived',
                  'Files aren’t available while the workspace is archived.'
                )
              : t(
                  'orcaCloudWorkspace.files.asleep',
                  'Files aren’t available while the workspace is asleep.'
                )}
          </p>
          {wake}
        </div>
      )}
    </div>
  )
}

type Git = NonNullable<CloudOfflineSnapshot['git']>

function SavedChanges({
  git,
  at,
  now,
  archived
}: {
  git: Git
  at: number | null
  now: number
  archived: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const time = at ? formatWhen(at, now, locale, t) : null
  if (git.changes.length === 0 && git.changeCount === 0) {
    return (
      <p className="text-muted-foreground">
        {archived
          ? time
            ? t(
                'orcaCloudWorkspace.files.noChangesAtArchive',
                'No files had changed when this workspace was archived · {{time}}',
                { time }
              )
            : t(
                'orcaCloudWorkspace.files.noChangesAtArchiveNoTime',
                'No files had changed when this workspace was archived'
              )
          : time
            ? t(
                'orcaCloudWorkspace.files.noChangesAtSleep',
                'No files had changed when this workspace went to sleep · {{time}}',
                { time }
              )
            : t(
                'orcaCloudWorkspace.files.noChangesAtSleepNoTime',
                'No files had changed when this workspace went to sleep'
              )}
      </p>
    )
  }
  const hidden = Math.max(0, git.changeCount - git.changes.length)
  return (
    <section
      className="flex flex-col gap-1.5"
      aria-label={t('orcaCloudWorkspace.files.changedTitle', 'Changed files')}
    >
      <h3 className="font-medium text-foreground">
        {archived
          ? time
            ? t(
                'orcaCloudWorkspace.files.changedAtArchive',
                'Changed files when this workspace was archived · {{time}}',
                { time }
              )
            : t(
                'orcaCloudWorkspace.files.changedAtArchiveNoTime',
                'Changed files when this workspace was archived'
              )
          : time
            ? t(
                'orcaCloudWorkspace.files.changedAtSleep',
                'Changed files when this workspace went to sleep · {{time}}',
                { time }
              )
            : t(
                'orcaCloudWorkspace.files.changedAtSleepNoTime',
                'Changed files when this workspace went to sleep'
              )}
      </h3>
      <ul className="flex flex-col gap-0.5">
        {git.changes.map((change) => (
          <li key={change.path} className="flex min-w-0 items-baseline gap-2">
            <span className="w-3 shrink-0 font-mono text-muted-foreground" title={change.status}>
              {changeStatusLetter(change.status)}
            </span>
            <span className="min-w-0 truncate font-mono text-foreground" title={change.path}>
              {change.path}
            </span>
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <p className="text-muted-foreground">
          {t('orcaCloudWorkspace.files.moreChanged', '+{{count}} more', { count: hidden })}
        </p>
      ) : null}
    </section>
  )
}

function RecentCommits({ git, now }: { git: Git; now: number }): React.JSX.Element | null {
  const t = useTranslate()
  const locale = useIntlLocale()
  if (git.commits.length === 0) {
    return null
  }
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="font-medium text-foreground">
        {git.branch
          ? t('orcaCloudWorkspace.files.recentCommitsOn', 'Recent commits on {{branch}}', {
              branch: git.branch
            })
          : t('orcaCloudWorkspace.files.recentCommits', 'Recent commits')}
      </h3>
      <ul className="flex flex-col gap-1">
        {git.commits.map((commit) => (
          <li key={commit.id} className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-foreground" title={commit.subject}>
              {commit.subject}
            </span>
            <span className="shrink-0 font-mono text-muted-foreground">
              {commit.id.slice(0, 7)}
            </span>
            {commit.at ? (
              <span className="shrink-0 text-muted-foreground">
                {formatWhen(commit.at, now, locale, t)}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}
