import React, { useEffect, useRef, useState } from 'react'
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
import type { Mission } from '../../../../shared/types'

export function MissionDeleteDialog({
  mission,
  onOpenChange
}: {
  mission: Mission | null
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const deleteMission = useAppStore((s) => s.deleteMission)
  const repos = useAppStore((s) => s.repos)
  const [deleteWorktrees, setDeleteWorktrees] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [failed, setFailed] = useState(false)
  const missionId = mission?.id ?? null
  // Why: an in-flight delete may resolve after the dialog has switched to a
  // different mission (cancel A → open B). The ref lets the completion detect
  // that it is stale and skip touching the now-current mission's state.
  const currentMissionIdRef = useRef(missionId)
  useEffect(() => {
    currentMissionIdRef.current = missionId
  }, [missionId])

  // Why: the dialog stays mounted between opens, so a prior attempt's failure
  // banner, checkbox choice, and in-progress state must not leak into the next
  // mission's delete.
  useEffect(() => {
    if (missionId !== null) {
      setDeleteWorktrees(true)
      setFailed(false)
      setSubmitting(false)
    }
  }, [missionId])

  async function handleDelete(): Promise<void> {
    if (!mission || submitting) {
      return
    }
    const targetMissionId = mission.id
    setSubmitting(true)
    setFailed(false)
    try {
      const result = await deleteMission(targetMissionId, deleteWorktrees)
      if (currentMissionIdRef.current !== targetMissionId) {
        return
      }
      if (result?.deleted) {
        onOpenChange(false)
        return
      }
      setFailed(true)
    } finally {
      if (currentMissionIdRef.current === targetMissionId) {
        setSubmitting(false)
      }
    }
  }

  const repoNameById = new Map(repos.map((repo) => [repo.id, repo.displayName]))

  return (
    <Dialog open={mission !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate('auto.components.sidebar.MissionDeleteDialog.7c84ee0d7d', 'Delete Mission')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'auto.components.sidebar.MissionDeleteDialog.3a89f8d9b8',
              'Delete "{{value0}}"?',
              { value0: mission?.name ?? '' }
            )}
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-40 space-y-1 overflow-y-auto scrollbar-sleek text-xs text-muted-foreground">
          {mission?.members.map((member) => (
            <li key={member.repoId} className="truncate">
              {repoNameById.get(member.repoId) ?? member.repoId}
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-2">
          <Checkbox
            id="mission-delete-worktrees"
            checked={deleteWorktrees}
            onCheckedChange={(checked) => setDeleteWorktrees(checked === true)}
          />
          <Label htmlFor="mission-delete-worktrees" className="text-xs">
            {translate(
              'auto.components.sidebar.MissionDeleteDialog.cef9382dc6',
              'Also delete member workspaces'
            )}
          </Label>
        </div>
        {failed ? (
          <p className="text-xs text-destructive">
            {translate(
              'auto.components.sidebar.MissionDeleteDialog.b74a531d8d',
              'Some workspaces could not be deleted. Resolve the errors and try again.'
            )}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-xs"
            onClick={() => onOpenChange(false)}
          >
            {translate('auto.components.sidebar.MissionDeleteDialog.e0a412c615', 'Cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="text-xs"
            disabled={submitting}
            onClick={() => void handleDelete()}
          >
            {submitting
              ? translate('auto.components.sidebar.MissionDeleteDialog.fd82d0130a', 'Deleting...')
              : translate('auto.components.sidebar.MissionDeleteDialog.9ce0f98166', 'Delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
