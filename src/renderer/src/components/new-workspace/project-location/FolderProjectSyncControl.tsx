import { useEffect, useId, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import { Checkbox } from '@/components/ui/checkbox'
import { useTranslate } from '@/i18n/use-translate'
import type {
  NeedsSetupProjectHostOption,
  ReadyProjectHostSetupOption
} from '@/lib/workspace/creation/project-host-setup-options'
import { parseExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type {
  FolderProjectSyncStatus,
  FolderProjectSyncTarget
} from '../../../../../shared/project/folder-project-sync'

export function FolderProjectSyncControl({
  sourceRepoId,
  environmentId,
  onRetry
}: {
  sourceRepoId: string
  environmentId: string
  onRetry: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const labelId = useId()
  const [status, setStatus] = useState<FolderProjectSyncStatus | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    const read = window.api.projects.getFolderSyncStatus
    if (!read) {
      return
    }
    let closed = false
    const refresh = (): void => {
      void read({ sourceRepoId, environmentId })
        .then((result) => {
          if (!closed) {
            setStatus(result)
          }
        })
        .catch(() => {})
    }
    const stop = installWindowVisibilityInterval({
      run: refresh,
      intervalMs: 5_000,
      slowWhileUnfocused: true
    })
    return () => {
      closed = true
      stop()
    }
  }, [sourceRepoId, environmentId])

  if (!status || !window.api.projects.setFolderSyncPreference) {
    return null
  }
  if (status.pendingCopy) {
    return (
      <Button size="sm" variant="secondary" onClick={onRetry}>
        {t('auto.components.new.workspace.FolderProjectSync.retry', 'Finish folder setup')}
      </Button>
    )
  }
  const setPreference = window.api.projects.setFolderSyncPreference

  function toggle(autoSync: boolean): void {
    setSaving(true)
    void setPreference({ sourceRepoId, environmentId, autoSync })
      .then(setStatus)
      .catch((error: unknown) => {
        toast.error(
          t(
            'auto.components.new.workspace.FolderProjectSync.preferenceFailed',
            'Could not change folder sync'
          ),
          { description: error instanceof Error ? error.message : String(error) }
        )
      })
      .finally(() => setSaving(false))
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Checkbox
          id={labelId}
          checked={status.autoSync}
          onCheckedChange={(value) => toggle(value === true)}
          disabled={saving}
        />
        <label htmlFor={labelId} className="text-sm">
          {t(
            'auto.components.new.workspace.FolderProjectSync.autoSync',
            'Automatically sync with the local folder'
          )}
        </label>
      </div>
      {status.conflicts.length ? (
        <p className="break-words text-xs text-muted-foreground" role="status">
          {t(
            'auto.components.new.workspace.FolderProjectSync.conflicts',
            'Sync needs attention for {{paths}}. Both versions were kept.',
            { paths: status.conflicts.join(', ') }
          )}
        </p>
      ) : null}
      {status.error ? (
        <p className="break-words text-xs text-destructive" role="status">
          {status.error}
        </p>
      ) : null}
    </div>
  )
}

export function getFolderProjectSyncSelection(
  repo: Repo | undefined,
  hostId: string | null | undefined,
  options: readonly ReadyProjectHostSetupOption[]
): { target: FolderProjectSyncTarget; option: NeedsSetupProjectHostOption } | null {
  const host = parseExecutionHostId(hostId)
  if (!repo?.folderProjectSourceId || host?.kind !== 'runtime') {
    return null
  }
  const option = options.find((row) => row.repoId === repo.id && row.hostId === hostId)
  if (!option) {
    return null
  }
  const target = { sourceRepoId: repo.folderProjectSourceId, environmentId: host.environmentId }
  return {
    target,
    option: {
      ...option,
      kind: 'needs-setup',
      isAvailable: true,
      attention: false,
      canSetLocation: true,
      folderReplica: { ...target, retry: true }
    }
  }
}
