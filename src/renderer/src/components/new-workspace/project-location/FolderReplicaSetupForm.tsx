import { useId, useState } from 'react'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import type {
  FolderProjectSetupRequest,
  FolderProjectSyncTarget
} from '../../../../../shared/project/folder-project-sync'
import type { NeedsSetupProjectHostOption } from '@/lib/workspace/creation/project-host-setup-options'
import { getProjectHostSetupSelectionKey } from '@/lib/workspace/creation/project-host-setup-options'

export function FolderReplicaSetupForm({
  option,
  target,
  projectName,
  pending,
  onPendingChange,
  onReady
}: {
  option: NeedsSetupProjectHostOption
  target: FolderProjectSyncTarget & { retry?: boolean }
  projectName: string
  pending: boolean
  onPendingChange: (pending: boolean) => void
  onReady: (setupId: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const checkboxId = useId()
  const [autoSync, setAutoSync] = useState(false)
  const [retry, setRetry] = useState(Boolean(target.retry))
  const [error, setError] = useState<string | null>(null)

  function submit(copyContents: boolean): void {
    if (pending) {
      return
    }
    onPendingChange(true)
    setError(null)
    const refreshFailure = t(
      'auto.components.new.workspace.FolderProjectSync.refreshFailed',
      'Could not load the new folder from the server. Try again.'
    )
    void prepareFolderReplica({ ...target, copyContents, autoSync }, option, refreshFailure)
      .then(onReady)
      .catch(async (failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure))
        const status = await window.api.projects.getFolderSyncStatus?.(target).catch(() => null)
        if (status?.pendingCopy) {
          setRetry(true)
        }
      })
      .finally(() => onPendingChange(false))
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {t(
            'auto.components.new.workspace.FolderProjectSync.title',
            'Copy this folder to the server?'
          )}
        </DialogTitle>
        <DialogDescription>
          {retry
            ? t(
                'auto.components.new.workspace.FolderProjectSync.retryDescription',
                'Retry copying files for {{project}} on {{host}}, or continue with the files already there.',
                { project: projectName, host: option.label }
              )
            : t(
                'auto.components.new.workspace.FolderProjectSync.description',
                'Orca will create a folder for {{project}} on {{host}}. You can copy your local files or start with an empty folder.',
                { project: projectName, host: option.label }
              )}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Checkbox
            id={checkboxId}
            checked={autoSync}
            onCheckedChange={(value) => setAutoSync(value === true)}
            disabled={pending}
          />
          <label htmlFor={checkboxId} className="text-sm">
            {t(
              'auto.components.new.workspace.FolderProjectSync.autoSync',
              'Automatically sync with the local folder'
            )}
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          {t(
            'auto.components.new.workspace.FolderProjectSync.autoSyncHelp',
            'While Orca is open, changes made after setup sync in both directions.'
          )}
        </p>
        {pending ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t(
              'auto.components.new.workspace.FolderProjectSync.preparing',
              'Preparing the folder on the server…'
            )}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="break-words text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="secondary" disabled={pending} onClick={() => submit(false)}>
          {retry
            ? t(
                'auto.components.new.workspace.FolderProjectSync.continue',
                'Continue without copying'
              )
            : t(
                'auto.components.new.workspace.FolderProjectSync.withoutCopy',
                'Create empty folder'
              )}
        </Button>
        <Button disabled={pending} onClick={() => submit(true)}>
          {t('auto.components.new.workspace.FolderProjectSync.copy', 'Copy files')}
        </Button>
      </DialogFooter>
    </>
  )
}

async function prepareFolderReplica(
  request: FolderProjectSetupRequest,
  option: NeedsSetupProjectHostOption,
  refreshFailure: string
): Promise<string> {
  const repo = await window.api.projects.setupFolderReplica?.(request)
  if (!repo) {
    throw new Error(refreshFailure)
  }
  await useAppStore.getState().fetchRepos({ runtimeEnvironmentId: request.environmentId })
  if (
    !useAppStore
      .getState()
      .projectHostSetups.some((row) => row.repoId === repo.id && row.hostId === option.hostId)
  ) {
    throw new Error(refreshFailure)
  }
  return getProjectHostSetupSelectionKey({ id: repo.id, hostId: option.hostId })
}
