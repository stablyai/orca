import React from 'react'
import { Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useNow } from '@/hooks/use-now'
import { useTranslate } from '@/i18n/use-translate'
import { formatElapsedTime } from '@/components/worktree-creation/worktree-creation-clock'
import { CloudGitChanges } from '../CloudGitChanges'
import { wakeCloudWorkspace } from '../cloud-workspace-actions'
import { useCloudOfflineData } from './use-cloud-offline-data'
import type { CloudOfflineSnapshot } from '../../../../../shared/hosted-sandbox/cloud-workspace-offline-api'

/**
 * The Files tab of an Orca Cloud workspace that is asleep (RA-10). There is no file tree without
 * the VM, so instead of a read error and Retry: the files that had changed when it went to sleep
 * (from its read snapshot or this computer's cache), read-only and labeled as such, then Wake for
 * the full view. With no snapshot, a neutral note and Wake.
 */
export function CloudAsleepFilesPanel({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const t = useTranslate()
  const { snapshot } = useCloudOfflineData(workspaceId, true)
  const now = useNow(30_000)
  const git = snapshot?.git ?? null
  const wake = (
    <Button size="xs" variant="outline" onClick={() => void wakeCloudWorkspace(workspaceId)}>
      <Play />
      {t('orcaCloudWorkspace.wake', 'Wake')}
    </Button>
  )
  return (
    <div
      className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto px-3 py-3 text-xs scrollbar-sleek"
      data-cloud-asleep-files={git ? 'snapshot' : 'none'}
    >
      {git ? (
        <>
          <SavedChanges git={git} at={snapshot?.capturedAt ?? null} now={now} />
          <div className="flex flex-col items-start gap-2 border-t border-border/60 pt-3 text-muted-foreground">
            <p>
              {t(
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
            {t(
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

function SavedChanges({
  git,
  at,
  now
}: {
  git: NonNullable<CloudOfflineSnapshot['git']>
  at: number | null
  now: number
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="font-medium text-foreground">
        {at
          ? t(
              'orcaCloudWorkspace.files.changedAtSleep',
              'Changed files when this workspace went to sleep · {{time}}',
              {
                time: t('orcaCloudWorkspace.ago', '{{ago}} ago', {
                  ago: formatElapsedTime(Math.max(0, now - at))
                })
              }
            )
          : t(
              'orcaCloudWorkspace.files.changedAtSleepNoTime',
              'Changed files when this workspace went to sleep'
            )}
      </h3>
      <CloudGitChanges
        now={now}
        data={{
          branch: git.branch,
          changes: git.changes,
          changeCount: git.changeCount,
          lineTotals:
            typeof git.added === 'number' && typeof git.removed === 'number'
              ? { added: git.added, removed: git.removed }
              : null,
          commits: git.commits.map((commit) => ({
            sha: commit.id,
            subject: commit.subject,
            at: commit.at
          }))
        }}
      />
    </section>
  )
}
