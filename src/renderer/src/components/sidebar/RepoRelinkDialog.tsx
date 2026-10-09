import React, { useCallback, useState } from 'react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import {
  getRepoPathStatusDescription,
  getRepoPathStatusTitle,
  getRepoRelinkErrorDescription,
  getRepoRelinkErrorTitle,
  isActionableRepoPathStatus
} from '@/lib/repo-path-status-copy'
import {
  getRepoExecutionHostId,
  normalizeExecutionHostId,
  parseExecutionHostId
} from '../../../../shared/execution-host'
import { getRepoHostIdentityForParts } from '../../../../shared/repo-host-identity'
import {
  isForceableRepoRelinkError,
  type RepoRelinkErrorCode
} from '../../../../shared/repo-path-status'

type RelinkError = { code: RepoRelinkErrorCode | null; message: string }

const RepoRelinkDialog = React.memo(function RepoRelinkDialog() {
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const relinkRepo = useAppStore((s) => s.relinkRepo)
  const repoId = typeof modalData.repoId === 'string' ? modalData.repoId : ''
  const hostId =
    typeof modalData.hostId === 'string' ? normalizeExecutionHostId(modalData.hostId) : null
  const repo = useAppStore((s) =>
    s.repos.find(
      (candidate) =>
        candidate.id === repoId && (!hostId || getRepoExecutionHostId(candidate) === hostId)
    )
  )
  const entry = useAppStore((s) =>
    hostId ? s.repoPathStatuses[getRepoHostIdentityForParts(repoId, hostId)] : undefined
  )
  const status = entry && repo && entry.path === repo.path ? entry.status : null
  const movedTarget = status?.state === 'moved' ? status.target : null
  const [path, setPath] = useState(movedTarget ?? '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<RelinkError | null>(null)
  // Only local folders have a native picker; remote paths are typed on the host's terms.
  const canBrowse = hostId !== null && parseExecutionHostId(hostId)?.kind === 'local'

  const browse = useCallback(async () => {
    const picked = await window.api.repos.pickFolder()
    if (picked) {
      setPath(picked)
      setError(null)
    }
  }, [])

  const submit = useCallback(
    async (force: boolean) => {
      if (!repo || !path.trim() || pending) {
        return
      }
      setPending(true)
      setError(null)
      const outcome = await relinkRepo(repo.id, path.trim(), {
        hostId: getRepoExecutionHostId(repo),
        force
      })
      setPending(false)
      if (!outcome.ok) {
        setError({ code: outcome.code, message: outcome.message })
        return
      }
      toast.success(
        translate('auto.components.sidebar.RepoRelinkDialog.relinked', 'Relinked {{name}}', {
          name: repo.displayName
        })
      )
      closeModal()
    },
    [closeModal, path, pending, relinkRepo, repo]
  )

  if (!repo) {
    return null
  }
  const title = isActionableRepoPathStatus(status)
    ? getRepoPathStatusTitle(status)
    : translate('auto.components.sidebar.RepoRelinkDialog.title', 'Relink repository')
  const description = isActionableRepoPathStatus(status)
    ? getRepoPathStatusDescription(status, repo.path)
    : translate(
        'auto.components.sidebar.RepoRelinkDialog.description',
        'Point {{name}} at its new folder to keep its worktrees and tabs.',
        { name: repo.displayName }
      )
  const forceable = error?.code ? isForceableRepoRelinkError(error.code) : false

  return (
    <Dialog open onOpenChange={(open) => !open && closeModal()}>
      <DialogContent className="max-w-md sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="break-words">{description}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault()
            void submit(false)
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="repo-relink-path">
              {translate('auto.components.sidebar.RepoRelinkDialog.pathLabel', 'New location')}
            </Label>
            {status?.state === 'missing' ? null : (
              <div className="break-words text-xs text-muted-foreground">
                {translate(
                  'auto.components.sidebar.RepoRelinkDialog.previous',
                  'Previously {{path}}',
                  { path: repo.path }
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Input
              id="repo-relink-path"
              autoFocus
              value={path}
              placeholder={repo.path}
              aria-invalid={error ? true : undefined}
              onChange={(event) => {
                setPath(event.target.value)
                setError(null)
              }}
            />
            {canBrowse ? (
              <Button type="button" variant="outline" onClick={() => void browse()}>
                {translate('auto.components.sidebar.RepoRelinkDialog.browse', 'Locate…')}
              </Button>
            ) : null}
          </div>
          {error ? (
            <div role="alert" className="space-y-1 text-xs">
              <div className="font-medium text-destructive">
                {getRepoRelinkErrorTitle(error.code)}
              </div>
              <div className="break-words text-muted-foreground">
                {getRepoRelinkErrorDescription(error.code, repo.displayName) ?? error.message}
              </div>
            </div>
          ) : null}
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={closeModal}>
            {translate('auto.components.sidebar.RepoRelinkDialog.cancel', 'Cancel')}
          </Button>
          {forceable ? (
            <Button variant="outline" disabled={pending} onClick={() => void submit(true)}>
              {translate('auto.components.sidebar.RepoRelinkDialog.force', 'Relink anyway')}
            </Button>
          ) : null}
          <Button disabled={pending || !path.trim()} onClick={() => void submit(false)}>
            {movedTarget
              ? translate('auto.components.sidebar.RepoRelinkDialog.update', 'Update location')
              : translate('auto.components.sidebar.RepoRelinkDialog.relink', 'Relink')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default RepoRelinkDialog
