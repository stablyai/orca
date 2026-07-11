import React, { useId, useMemo, useRef, useState } from 'react'
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
import RepoMultiCombobox from '@/components/ui/repo-multi-combobox'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { slugifyMissionBranch } from '../../../../shared/missions'

export default function MissionCreateDialog(): React.JSX.Element {
  const open = useAppStore((s) => s.activeModal === 'mission-create')
  const closeModal = useAppStore((s) => s.closeModal)
  const repos = useAppStore((s) => s.repos)
  const createMission = useAppStore((s) => s.createMission)
  const setSidebarListMode = useAppStore((s) => s.setSidebarListMode)

  const nameId = useId()
  const branchId = useId()
  const [name, setName] = useState('')
  const [branch, setBranch] = useState('')
  const branchDirtyRef = useRef(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [submitting, setSubmitting] = useState(false)

  const effectiveBranch =
    branchDirtyRef.current && branch.trim() ? branch.trim() : slugifyMissionBranch(name)
  const selectedIds = useMemo(() => [...selected], [selected])
  const canSubmit = name.trim().length > 0 && selectedIds.length > 0 && !submitting

  function resetAndClose(): void {
    setName('')
    setBranch('')
    branchDirtyRef.current = false
    setSelected(new Set())
    setSubmitting(false)
    closeModal()
  }

  async function handleSubmit(event?: React.FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault()
    if (!canSubmit) {
      return
    }
    setSubmitting(true)
    const result = await createMission({
      name: name.trim(),
      branchName: effectiveBranch,
      repoIds: selectedIds
    })
    if (result) {
      // Why: creation lands in the Missions tab even when triggered elsewhere,
      // so the user sees per-member results (including failures) immediately.
      setSidebarListMode('missions')
      resetAndClose()
      return
    }
    setSubmitting(false)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? resetAndClose() : undefined)}>
      <DialogContent className="max-w-sm sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate('auto.components.sidebar.MissionCreateDialog.0655a02f86', 'New Mission')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'auto.components.sidebar.MissionCreateDialog.4608f14ade',
              'Each selected project gets a workspace on a shared mission branch.'
            )}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1">
            <Label htmlFor={nameId} className="text-[11px] text-muted-foreground">
              {translate('auto.components.sidebar.MissionCreateDialog.48ec5c5b11', 'Mission Name')}
            </Label>
            <Input
              id={nameId}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={branchId} className="text-[11px] text-muted-foreground">
              {translate('auto.components.sidebar.MissionCreateDialog.0c9fe9ce6d', 'Branch')}
            </Label>
            <Input
              id={branchId}
              value={branchDirtyRef.current ? branch : effectiveBranch}
              onChange={(event) => {
                branchDirtyRef.current = true
                setBranch(event.target.value)
              }}
              className="h-8 font-mono text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">
              {translate('auto.components.sidebar.MissionCreateDialog.bcea32d392', 'Projects')}
            </Label>
            <RepoMultiCombobox
              repos={repos}
              selected={selected}
              onChange={setSelected}
              onSelectAll={() => setSelected(new Set(repos.map((repo) => repo.id)))}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-xs"
              onClick={resetAndClose}
            >
              {translate('auto.components.sidebar.MissionCreateDialog.741e98ec23', 'Cancel')}
            </Button>
            <Button type="submit" size="sm" className="text-xs" disabled={!canSubmit}>
              {submitting
                ? translate('auto.components.sidebar.MissionCreateDialog.131ac9a3ca', 'Creating...')
                : translate(
                    'auto.components.sidebar.MissionCreateDialog.470b9ba02f',
                    'Create Mission'
                  )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
