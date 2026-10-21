import React, { useEffect, useMemo, useState } from 'react'
import { Archive, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useAppStore } from '@/store'
import { useMachineSources } from '@/store/machines'
import { translate } from '@/i18n/i18n'
import { formatMachineWorkAtRisk, type MachineTarget } from '../../../../shared/machine-inventory'
import type { GitUpstreamStatus } from '../../../../shared/git-status-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { type MachineMatch, worktreesOnMachine } from '@/lib/machines/machine-host-match'
import { getMachineMenuActions, runMachineMenuAction } from '@/lib/machines/machine-actions'
import { deleteMachineWithWorktrees } from '@/lib/machines/machine-delete'
import {
  describeWorktreeWork,
  getWorktreeWorkCheck,
  type MachineWorkRead
} from '@/lib/machines/machine-delete-work'
import { useDeleteWorktreeStatusHydration } from '@/components/sidebar/use-delete-worktree-status-hydration'

function confirmLabel(worktreeCount: number): string {
  if (worktreeCount === 0) {
    return translate('auto.components.machines.MachineDeleteDialog.confirm', 'Delete machine')
  }
  return worktreeCount === 1
    ? translate(
        'auto.components.machines.MachineDeleteDialog.confirmWithWorktree',
        'Delete machine and 1 worktree'
      )
    : translate(
        'auto.components.machines.MachineDeleteDialog.confirmWithWorktrees',
        'Delete machine and {{count}} worktrees',
        { count: worktreeCount }
      )
}

/** Worktrees on any of this machine's hosts; a delete removes them along with it. */
function useBoundWorktrees(match: MachineMatch): Worktree[] {
  const worktreesByRepo = useAppStore((state) => state.worktreesByRepo)
  const repos = useAppStore((state) => state.repos)
  return useMemo(
    () => worktreesOnMachine(match, { worktreesByRepo, repos }),
    [match, repos, worktreesByRepo]
  )
}

/** Unpushed-commit status per worktree, read once while the dialog is open on a running machine. */
function useUpstreamStatuses(
  worktrees: readonly Worktree[],
  enabled: boolean
): ReadonlyMap<string, GitUpstreamStatus | null> {
  const [statuses, setStatuses] = useState<ReadonlyMap<string, GitUpstreamStatus | null>>(
    () => new Map()
  )
  const ids = worktrees.map((worktree) => worktree.id).join('\n')
  useEffect(() => {
    if (!enabled) {
      return
    }
    let stale = false
    const store = useAppStore.getState()
    const repoById = new Map(store.repos.map((repo) => [repo.id, repo]))
    for (const worktree of worktrees) {
      void store
        .fetchUpstreamStatus(
          worktree.id,
          worktree.path,
          repoById.get(worktree.repoId)?.connectionId ?? undefined,
          worktree.pushTarget
        )
        .catch(() => null)
        .then((status) => {
          if (!stale) {
            setStatuses((current) => new Map(current).set(worktree.id, status))
          }
        })
    }
    return () => {
      stale = true
    }
    // Why: re-read only when the set of worktrees changes, not on every inventory push.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ids])
  return statuses
}

/** A stopped machine's work as its Orca server reports it, totalled; null when it can't say. */
function useStoppedMachineWork(target: MachineTarget, enabled: boolean): MachineWorkRead {
  const [work, setWork] = useState<MachineWorkRead>('checking')
  const { providerKey, machineId } = target
  useEffect(() => {
    if (!enabled) {
      return
    }
    let stale = false
    setWork('checking')
    void window.api.machines.workAtRisk({ providerKey, machineId }).then(
      (result) => !stale && setWork(result.ok ? result.value : null),
      () => !stale && setWork(null)
    )
    return () => {
      stale = true
    }
  }, [enabled, providerKey, machineId])
  return work
}

function MachineDeleteBody({
  match,
  onClose
}: {
  match: MachineMatch
  onClose: () => void
}): React.JSX.Element {
  const [deleting, setDeleting] = useState(false)
  const worktrees = useBoundWorktrees(match)
  const repos = useAppStore((state) => state.repos)
  const repoMap = useMemo(() => new Map(repos.map((repo) => [repo.id, repo])), [repos])
  // Why: a stopped machine can't answer, so its work reads as unknown rather than clean.
  const running = match.machine.state === 'running'
  const uncommittedByIdentity = useDeleteWorktreeStatusHydration({
    isOpen: running,
    deleteTargets: worktrees,
    visibleTargets: worktrees,
    repoMap,
    includeMainWorktrees: true
  })
  const upstream = useUpstreamStatuses(worktrees, running)
  const stoppedWork = useStoppedMachineWork(
    { providerKey: match.snapshot.providerKey, machineId: match.machine.id },
    !running && worktrees.length > 0
  )
  // One formatter with main's expiry warning, so never-pushed branches are named here too.
  const stoppedTotal =
    !running && stoppedWork !== null && stoppedWork !== 'checking'
      ? formatMachineWorkAtRisk(stoppedWork, translate)
      : null
  const canArchive = getMachineMenuActions(match).includes('archive')
  const name = match.machine.name

  const confirm = async (): Promise<void> => {
    setDeleting(true)
    try {
      const result = await deleteMachineWithWorktrees(match, worktrees, repos)
      if (result.ok) {
        onClose()
        return
      }
      toast.error(
        translate(
          'auto.components.machines.MachineDeleteDialog.failed',
          'Couldn’t delete {{name}}',
          {
            name
          }
        ),
        { description: result.error }
      )
    } finally {
      setDeleting(false)
    }
  }

  return (
    <DialogContent className="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>
          {translate('auto.components.machines.MachineDeleteDialog.title', 'Delete {{name}}', {
            name
          })}
        </DialogTitle>
        <DialogDescription>
          {worktrees.length === 1
            ? translate(
                'auto.components.machines.MachineDeleteDialog.descriptionWithWorktree',
                'Deletes the machine on {{provider}} and the worktree on it. This can’t be undone.',
                { provider: match.snapshot.name }
              )
            : worktrees.length > 1
              ? translate(
                  'auto.components.machines.MachineDeleteDialog.descriptionWithWorktrees',
                  'Deletes the machine on {{provider}} and the {{count}} worktrees on it. This can’t be undone.',
                  { provider: match.snapshot.name, count: worktrees.length }
                )
              : translate(
                  'auto.components.machines.MachineDeleteDialog.description',
                  'Deletes the machine on {{provider}}. This can’t be undone.',
                  { provider: match.snapshot.name }
                )}
        </DialogDescription>
      </DialogHeader>
      {stoppedTotal ? (
        <p className="text-xs text-status-warning">
          {translate(
            'auto.components.machines.MachineDeleteDialog.machineTotal',
            'Across these worktrees: {{work}}',
            { work: stoppedTotal }
          )}
        </p>
      ) : null}
      {worktrees.length > 0 ? (
        <ul className="scrollbar-sleek max-h-[50vh] min-w-0 divide-y divide-border overflow-y-auto rounded-md border border-border">
          {worktrees.map((worktree) => {
            const work = getWorktreeWorkCheck(
              running,
              stoppedWork,
              running ? uncommittedByIdentity.get(getWorktreeHostIdentity(worktree)) : null,
              upstream.get(worktree.id)
            )
            const status = work ? describeWorktreeWork(work) : null
            return (
              <li key={worktree.id} className="min-w-0 px-3 py-2">
                <div className="truncate text-sm font-medium">
                  {worktree.displayName || worktree.branch}
                </div>
                <div className="truncate text-xs text-muted-foreground">{worktree.path}</div>
                {status ? (
                  <div
                    data-at-risk={status.atRisk}
                    className="mt-0.5 text-xs text-muted-foreground data-[at-risk=true]:text-status-warning"
                  >
                    {status.text}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}
      <DialogFooter className="sm:justify-between">
        {canArchive ? (
          <Button
            variant="ghost"
            disabled={deleting}
            onClick={() => {
              void runMachineMenuAction('archive', match)
              onClose()
            }}
          >
            <Archive />
            {translate(
              'auto.components.machines.MachineDeleteDialog.archiveInstead',
              'Archive instead'
            )}
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button variant="outline" disabled={deleting} onClick={onClose}>
            {translate('auto.components.machines.MachineDeleteDialog.cancel', 'Cancel')}
          </Button>
          <Button variant="destructive" disabled={deleting} onClick={() => void confirm()}>
            <Trash2 />
            {confirmLabel(worktrees.length)}
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  )
}

function findTargetMatch(
  sources: ReturnType<typeof useMachineSources>,
  target: MachineTarget
): MachineMatch | null {
  const snapshot = sources.self.find((entry) => entry.providerKey === target.providerKey)
  const machine = snapshot?.machines.find((entry) => entry.id === target.machineId)
  return snapshot && machine ? { snapshot, machine, environmentId: null } : null
}

/** The one Delete dialog every machine menu opens; its body mounts only while a machine is targeted. */
export function MachineDeleteDialog(): React.JSX.Element | null {
  const target = useAppStore((state) => state.machineDeleteTarget)
  if (!target) {
    return null
  }
  return <MachineDeleteDialogForTarget target={target} />
}

function MachineDeleteDialogForTarget({ target }: { target: MachineTarget }): React.JSX.Element {
  const setTarget = useAppStore((state) => state.setMachineDeleteTarget)
  const sources = useMachineSources()
  const match = findTargetMatch(sources, target)
  const close = (): void => setTarget(null)
  return (
    <Dialog open={match !== null} onOpenChange={(next) => (next ? undefined : close())}>
      {match ? <MachineDeleteBody match={match} onClose={close} /> : null}
    </Dialog>
  )
}
