import React from 'react'
import { AlertTriangle, Check, CircleDashed, LoaderCircle, Trash2 } from 'lucide-react'
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
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'
import { RemovalUnsavedFilesNotice } from '@/components/sidebar/RemovalUnsavedFilesNotice'
import { collectRemovalUnsavedFiles } from '@/components/editor/removal-unsaved-editor-files'
import type { WorktreePurgeTarget } from '@/store/slices/worktree-helpers'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  applyDeleteResult,
  buildDeleteRows,
  countFailed,
  countRemaining,
  enterConfirmsDelete,
  getForcedMemberIds,
  markRemoving,
  toggleForceMember,
  type DeleteRow
} from './delete-dialog-model'
import {
  getBranchNote,
  getDeleteBody,
  getDeleteButtonLabel,
  getDeleteTitle,
  getForceLabel,
  getRootKeptText,
  getRowRiskText,
  getRowStatusText
} from './delete-dialog-copy'

type LoadState =
  | { kind: 'checking' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; rows: DeleteRow[] }

function RowIcon({ row }: { row: DeleteRow }): React.JSX.Element {
  // Decorative: every state is also written out in the row text.
  if (row.phase === 'removing') {
    return (
      <LoaderCircle
        aria-hidden="true"
        className="size-3.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
      />
    )
  }
  if (row.phase === 'removed') {
    return <Check aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
  }
  if (row.phase === 'failed' || row.risky) {
    return <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0 text-destructive" />
  }
  return <CircleDashed aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
}

export default function DeleteMultiRepoWorkspaceDialog(): React.JSX.Element | null {
  const modalData = useAppStore((state) => state.modalData)
  const closeModal = useAppStore((state) => state.closeModal)
  const folderWorkspaces = useAppStore((state) => selectFolderWorkspaces(state))
  const repos = useAppStore((state) => state.repos)
  const inspect = useAppStore((state) => state.inspectMultiRepoWorkspaceDelete)
  const deleteWorkspace = useAppStore((state) => state.deleteMultiRepoWorkspace)

  const folderWorkspaceId =
    typeof modalData.folderWorkspaceId === 'string' ? modalData.folderWorkspaceId : null
  const executionHostId =
    typeof modalData.executionHostId === 'string'
      ? // The caller passes the owner host id it read off the sidebar row.
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: written by the delete entry point from an ExecutionHostId.
        (modalData.executionHostId as ExecutionHostId)
      : undefined
  const folderWorkspace = folderWorkspaces.find((workspace) => workspace.id === folderWorkspaceId)

  const [load, setLoad] = React.useState<LoadState>({ kind: 'checking' })
  const [forced, setForced] = React.useState<ReadonlySet<string>>(new Set())
  const [deleting, setDeleting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const confirmRef = React.useRef<HTMLButtonElement>(null)
  const forceIdPrefix = React.useId()

  React.useEffect(() => {
    if (!folderWorkspaceId) {
      return
    }
    let cancelled = false
    setLoad({ kind: 'checking' })
    inspect({ folderWorkspaceId, ...(executionHostId ? { executionHostId } : {}) })
      .then((inspection) => {
        if (cancelled) {
          return
        }
        const labels = new Map(
          (folderWorkspace?.multiRepo?.members ?? []).map((member) => [
            member.memberId,
            {
              label: repos.find((repo) => repo.id === member.repoId)?.displayName ?? member.dirName,
              branchName: member.branchName
            }
          ])
        )
        setLoad({ kind: 'ready', rows: buildDeleteRows(inspection, labels) })
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setLoad({
            kind: 'error',
            message: reason instanceof Error ? reason.message : String(reason)
          })
        }
      })
    return () => {
      cancelled = true
    }
    // The inspection is a one-shot read of the workspace as it was when the dialog opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderWorkspaceId, executionHostId])

  // Targets whose open files this delete closes: the workspace folder and every member worktree.
  const unsavedTargets = React.useMemo<WorktreePurgeTarget[]>(
    () =>
      folderWorkspaceId
        ? [
            { id: folderWorkspaceKey(folderWorkspaceId), hostId: executionHostId },
            ...(folderWorkspace?.multiRepo?.members ?? []).flatMap((member) =>
              member.worktreeId ? [{ id: member.worktreeId, hostId: executionHostId }] : []
            )
          ]
        : [],
    [executionHostId, folderWorkspace, folderWorkspaceId]
  )

  const rows = load.kind === 'ready' ? load.rows : []
  const failedCount = countFailed(rows)
  const retryPhase = failedCount > 0
  const forcedIds = getForcedMemberIds(rows, forced)

  const handleOpenChange = (open: boolean): void => {
    if (!open && !deleting) {
      closeModal()
    }
  }

  const handleConfirm = async (): Promise<void> => {
    if (!folderWorkspaceId || load.kind !== 'ready' || deleting) {
      return
    }
    setDeleting(true)
    setError(null)
    setLoad({ kind: 'ready', rows: markRemoving(load.rows) })
    try {
      const result = await deleteWorkspace({
        folderWorkspaceId,
        ...(executionHostId ? { executionHostId } : {}),
        ...(forcedIds.length > 0 ? { forceMemberIds: forcedIds } : {})
      })
      const next = applyDeleteResult(load.rows, result)
      setLoad({ kind: 'ready', rows: next })
      if (result.workspaceRemoved) {
        if (result.rootKept) {
          toast.info(getRootKeptText(result.rootKept))
        }
        closeModal()
      }
    } catch (reason) {
      setLoad({
        kind: 'ready',
        rows: load.rows.map((row) => (row.phase === 'removed' ? row : { ...row, phase: 'idle' }))
      })
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setDeleting(false)
    }
  }

  if (!folderWorkspaceId) {
    return null
  }
  const name = folderWorkspace?.name ?? folderWorkspaceId
  const checking = load.kind === 'checking'
  const confirmDisabled = deleting || load.kind !== 'ready'
  const cleanEnter = load.kind === 'ready' && enterConfirmsDelete(rows)

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent
        surface="security"
        className="max-w-lg"
        onOpenAutoFocus={(event) => {
          // Enter confirms only a clean workspace without unsaved edits; otherwise keep Radix's default focus.
          if (
            !cleanEnter ||
            collectRemovalUnsavedFiles(useAppStore.getState, unsavedTargets).length > 0
          ) {
            return
          }
          event.preventDefault()
          confirmRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{getDeleteTitle(name)}</DialogTitle>
          <DialogDescription>
            {getDeleteBody(
              load.kind === 'ready'
                ? rows.length
                : (folderWorkspace?.multiRepo?.members.length ?? 0)
            )}
          </DialogDescription>
        </DialogHeader>

        <RemovalUnsavedFilesNotice targets={unsavedTargets} enabled />

        {load.kind === 'error' ? (
          <p role="alert" className="text-xs text-destructive">
            {load.message}
          </p>
        ) : (
          <ul className="max-h-72 space-y-1 overflow-y-auto scrollbar-sleek">
            {checking ? (
              <li className="text-xs text-muted-foreground">
                {translate('auto.components.multiRepo.delete.checking', 'Checking…')}
              </li>
            ) : null}
            {rows.map((row) => {
              const riskText = row.phase === 'idle' ? getRowRiskText(row) : null
              const branchNote = row.phase === 'idle' ? getBranchNote(row) : null
              const statusText = getRowStatusText(row, false)
              const forceId = `${forceIdPrefix}-${row.memberId}`
              return (
                <li
                  key={row.memberId}
                  className="rounded-md border border-border px-3 py-2 text-xs"
                >
                  <div className="flex items-center gap-2">
                    <RowIcon row={row} />
                    <span className="min-w-0 truncate text-sm text-foreground">{row.label}</span>
                    <span className="min-w-0 truncate font-mono text-muted-foreground">
                      {row.branchName}
                    </span>
                    {statusText ? (
                      <span className="ml-auto min-w-0 truncate text-muted-foreground">
                        {statusText}
                      </span>
                    ) : null}
                  </div>
                  {riskText ? <p className="mt-1 text-destructive">{riskText}</p> : null}
                  {branchNote ? <p className="mt-0.5 text-muted-foreground">{branchNote}</p> : null}
                  {row.risky && row.phase !== 'removed' ? (
                    <div className="mt-1.5 flex items-center gap-2">
                      <Checkbox
                        id={forceId}
                        checked={forced.has(row.memberId)}
                        disabled={deleting}
                        onCheckedChange={() =>
                          setForced((current) => toggleForceMember(current, row.memberId))
                        }
                      />
                      <Label htmlFor={forceId}>{getForceLabel(row)}</Label>
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}

        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={deleting}>
            {retryPhase
              ? translate('auto.components.multiRepo.delete.close', 'Close')
              : translate('auto.components.multiRepo.delete.cancel', 'Cancel')}
          </Button>
          <Button
            ref={confirmRef}
            variant="destructive"
            disabled={confirmDisabled}
            onClick={() => void handleConfirm()}
          >
            {deleting ? (
              <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <Trash2 />
            )}
            {getDeleteButtonLabel(
              countRemaining(rows) || rows.length,
              forcedIds.length,
              retryPhase ? 'retry' : 'confirm',
              failedCount
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
