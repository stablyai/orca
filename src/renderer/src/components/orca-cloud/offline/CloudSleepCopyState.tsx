// SLEEP-IN-PROGRESS: what a read-only pane shows while its sleeping workspace's copy is still being
// saved, and when it never arrived. Shown in place of the pane's "nothing was saved" lines, which
// are only true once a copy exists.
import React, { useEffect } from 'react'
import { LoaderCircle, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { useCloudOfflineData } from './use-cloud-offline-data'
import { noteSleepCopyRead, useSleepCopySave, type SleepCopySave } from '@/lib/worktree-sleep-view'

/** The copy's save state for a workspace; a read copy at least as new as the press ends saving. */
export function useSleepCopyProgress(
  workspaceId: string,
  capturedAt: number | null | undefined
): SleepCopySave['state'] | null {
  const save = useSleepCopySave(workspaceId)
  useEffect(() => {
    if (save && capturedAt !== undefined) {
      noteSleepCopyRead(workspaceId, capturedAt)
    }
  }, [save, workspaceId, capturedAt])
  return save?.state ?? null
}

/** The asleep view's data, read promptly while its copy saves, plus that copy's save state. */
export function useAsleepCopyData(
  workspaceId: string,
  enabled: boolean
): ReturnType<typeof useCloudOfflineData> & { copySave: SleepCopySave['state'] | null } {
  const saving = useSleepCopySave(workspaceId)?.state === 'saving'
  const offline = useCloudOfflineData(workspaceId, enabled, { saving })
  const copySave = useSleepCopyProgress(workspaceId, offline.snapshot?.capturedAt)
  return { ...offline, copySave }
}

export function CloudSleepCopySaving(): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      className="flex max-w-[60ch] items-start gap-3"
      role="status"
      data-cloud-sleep-copy="saving"
    >
      <LoaderCircle
        className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
        aria-hidden="true"
      />
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-foreground">
          {t('components.orcaCloud.offline.copySaving.title', 'Saving a read-only copy…')}
        </p>
        <p className="text-sm text-muted-foreground">
          {t(
            'components.orcaCloud.offline.copySaving.body',
            'Terminals, chats and changes will be readable here in a moment.'
          )}
        </p>
      </div>
    </div>
  )
}

/** `onWake` only where nothing else on screen offers Wake (the offline view's header does). */
export function CloudSleepCopyFailed({ onWake }: { onWake?: () => void }): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex max-w-[60ch] flex-col items-start gap-3" data-cloud-sleep-copy="failed">
      <p className="text-sm text-muted-foreground">
        {t(
          'components.orcaCloud.offline.copyFailed',
          'Couldn’t save a read-only copy. Your files are safe in the workspace.'
        )}
      </p>
      {onWake ? (
        <Button size="sm" variant="outline" onClick={onWake}>
          <Play />
          {t('components.orcaCloud.offline.copyFailedWake', 'Wake')}
        </Button>
      ) : null}
    </div>
  )
}
