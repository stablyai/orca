import React, { useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ensureHooksConfirmed } from '@/lib/ensure-hooks-confirmed'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import type { WorkspaceKey, Worktree } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import {
  getRelativeWorktreeDefaultName,
  type RelativeWorktreeCreateKind
} from './worktree-relative-create'

type Props = {
  kind: RelativeWorktreeCreateKind
  worktree: Worktree
  parentWorkspace: WorkspaceKey | null
  onOpenChange: (open: boolean) => void
}

export function RelativeWorktreeCreateDialog({
  kind,
  worktree,
  parentWorkspace,
  onOpenChange
}: Props): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(() => getRelativeWorktreeDefaultName(worktree, kind))
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen && creating) {
      return
    }
    onOpenChange(nextOpen)
  }

  const handleCreate = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const branchName = name.trim()
    const baseBranch = worktree.branch?.trim()
    if (!baseBranch || !branchName || creating) {
      return
    }
    setCreating(true)
    setError(null)
    try {
      const trustDecision = await ensureHooksConfirmed(
        useAppStore.getState(),
        worktree.repoId,
        'setup',
        worktree.hostId,
        worktree.runtimeOwnerEnvironmentId
      )
      const result = await useAppStore
        .getState()
        .createWorktree(
          worktree.repoId,
          branchName,
          baseBranch,
          trustDecision === 'skip' ? 'skip' : 'inherit',
          undefined,
          'sidebar',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          branchName,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          {
            parentWorkspace,
            executionHostId: worktree.hostId,
            runtimeOwnerEnvironmentId: worktree.runtimeOwnerEnvironmentId
          }
        )
      onOpenChange(false)
      activateAndRevealWorktree(result.worktree.id, {
        executionHostId: worktree.hostId,
        sidebarRevealBehavior: 'auto',
        setup: result.setup,
        defaultTabs: result.defaultTabs
      })
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : translate(
              'auto.components.sidebar.RelativeWorktreeCreateDialog.createFailed',
              'Failed to create worktree.'
            )
      )
    } finally {
      setCreating(false)
    }
  }

  const title =
    kind === 'fork'
      ? translate('auto.components.sidebar.RelativeWorktreeCreateDialog.forkTitle', 'Fork Worktree')
      : translate(
          'auto.components.sidebar.RelativeWorktreeCreateDialog.childTitle',
          'Create Child Worktree'
        )
  const actionLabel =
    kind === 'fork'
      ? translate('auto.components.sidebar.RelativeWorktreeCreateDialog.forkAction', 'Fork')
      : translate(
          'auto.components.sidebar.RelativeWorktreeCreateDialog.childAction',
          'Create Child'
        )

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          inputRef.current?.focus()
          inputRef.current?.select()
        }}
      >
        <form className="space-y-4" onSubmit={(event) => void handleCreate(event)}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {translate(
                'auto.components.sidebar.RelativeWorktreeCreateDialog.description',
                'Create a new worktree from the current branch.'
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="relative-worktree-branch-name">
              {translate(
                'auto.components.sidebar.RelativeWorktreeCreateDialog.branchName',
                'Branch name'
              )}
            </Label>
            <Input
              ref={inputRef}
              id="relative-worktree-branch-name"
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                setError(null)
              }}
              aria-invalid={Boolean(error)}
              disabled={creating}
              autoComplete="off"
            />
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost" disabled={creating}>
                {translate('auto.components.sidebar.RelativeWorktreeCreateDialog.cancel', 'Cancel')}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={!name.trim() || creating}>
              {creating ? <Loader2 className="size-4 animate-spin" /> : null}
              {creating
                ? translate(
                    'auto.components.sidebar.RelativeWorktreeCreateDialog.creating',
                    'Creating…'
                  )
                : actionLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
