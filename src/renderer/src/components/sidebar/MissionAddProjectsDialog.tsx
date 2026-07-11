import React, { useMemo, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import RepoMultiCombobox from '@/components/ui/repo-multi-combobox'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { Mission } from '../../../../shared/types'

export function MissionAddProjectsDialog({
  mission,
  onOpenChange
}: {
  mission: Mission | null
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const repos = useAppStore((s) => s.repos)
  const addMissionMembers = useAppStore((s) => s.addMissionMembers)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [submitting, setSubmitting] = useState(false)

  const memberIds = useMemo(
    () => new Set(mission?.members.map((member) => member.repoId) ?? []),
    [mission]
  )
  const candidates = useMemo(
    () => repos.filter((repo) => !memberIds.has(repo.id)),
    [repos, memberIds]
  )

  function close(): void {
    setSelected(new Set())
    setSubmitting(false)
    onOpenChange(false)
  }

  async function handleAdd(): Promise<void> {
    if (!mission || selected.size === 0 || submitting) {
      return
    }
    setSubmitting(true)
    await addMissionMembers(mission.id, [...selected])
    close()
  }

  return (
    <Dialog open={mission !== null} onOpenChange={(next) => (!next ? close() : undefined)}>
      <DialogContent className="max-w-sm sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate(
              'auto.components.sidebar.MissionAddProjectsDialog.6ec97cd26f',
              'Add Projects'
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'auto.components.sidebar.MissionAddProjectsDialog.02449d01cc',
              'Each added project gets a workspace on {{value0}}.',
              { value0: mission?.branchName ?? '' }
            )}
          </DialogDescription>
        </DialogHeader>
        {candidates.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.sidebar.MissionAddProjectsDialog.eb3a71b1fd',
              'All projects are already in this mission.'
            )}
          </p>
        ) : (
          <RepoMultiCombobox
            repos={candidates}
            selected={selected}
            onChange={setSelected}
            onSelectAll={() => setSelected(new Set(candidates.map((repo) => repo.id)))}
          />
        )}
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" className="text-xs" onClick={close}>
            {translate('auto.components.sidebar.MissionAddProjectsDialog.d5aae76bca', 'Cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            className="text-xs"
            disabled={selected.size === 0 || submitting}
            onClick={() => void handleAdd()}
          >
            {submitting
              ? translate(
                  'auto.components.sidebar.MissionAddProjectsDialog.e81ed87ddd',
                  'Adding...'
                )
              : translate('auto.components.sidebar.MissionAddProjectsDialog.36cc45b3fb', 'Add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
