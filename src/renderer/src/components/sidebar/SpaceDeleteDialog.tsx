import React from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import {
  DEFAULT_SPACE_FALLBACK_NAME,
  DEFAULT_SPACE_ID,
  isDefaultSpaceId,
  isRepoInSpace
} from '../../../../shared/spaces'

export default function SpaceDeleteDialog(): React.JSX.Element | null {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const spaces = useAppStore((s) => s.spaces)
  const repos = useAppStore((s) => s.repos)
  const deleteSpace = useAppStore((s) => s.deleteSpace)

  const confirmButtonRef = React.useRef<HTMLButtonElement>(null)

  const spaceId = typeof modalData.spaceId === 'string' ? modalData.spaceId : null
  const space = spaces.find((entry) => entry.id === spaceId) ?? null
  const defaultSpaceName =
    spaces.find((entry) => entry.id === DEFAULT_SPACE_ID)?.name ?? DEFAULT_SPACE_FALLBACK_NAME
  const open = activeModal === 'delete-space' && space !== null && !isDefaultSpaceId(space.id)
  // Why: repos holds one row per (project, host), so a project on both local and SSH would count twice.
  const projectCount = React.useMemo(
    () =>
      space
        ? new Set(repos.filter((repo) => isRepoInSpace(repo, space.id)).map((repo) => repo.id)).size
        : 0,
    [repos, space]
  )

  const handleConfirm = React.useCallback(() => {
    if (!space) {
      return
    }
    const deletedSpaceName = space.name
    closeModal()
    void deleteSpace(space.id).then((deleted) => {
      if (!deleted) {
        toast.error(
          translate(
            'auto.components.sidebar.SpaceDeleteDialog.deleteFailedToast',
            "Couldn't delete Space"
          ),
          {
            description: translate(
              'auto.components.sidebar.SpaceDeleteDialog.deleteFailedDescription',
              'The Space "{{value0}}" is still available. Try again.',
              { value0: deletedSpaceName }
            )
          }
        )
      }
    })
  }, [closeModal, deleteSpace, space])

  if (!open || !space) {
    return null
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && closeModal()}>
      <DialogContent
        className="max-w-sm sm:max-w-sm"
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          confirmButtonRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate('auto.components.sidebar.SpaceDeleteDialog.title', 'Delete Space')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate('auto.components.sidebar.SpaceDeleteDialog.deletePrefix', 'Delete')}{' '}
            <span className="break-all font-medium text-foreground">{space.name}</span>.
          </DialogDescription>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          {projectCount === 1
            ? translate(
                'auto.components.sidebar.SpaceDeleteDialog.reassignSingular',
                '1 project moves to {{value0}}. Nothing on disk is removed.',
                { value0: defaultSpaceName }
              )
            : translate(
                'auto.components.sidebar.SpaceDeleteDialog.reassignPlural',
                '{{value0}} projects move to {{value1}}. Nothing on disk is removed.',
                { value0: projectCount, value1: defaultSpaceName }
              )}
        </p>
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" className="text-xs" onClick={closeModal}>
            {translate('auto.components.sidebar.SpaceDeleteDialog.cancel', 'Cancel')}
          </Button>
          <Button
            ref={confirmButtonRef}
            type="button"
            variant="destructive"
            size="sm"
            className="text-xs"
            onClick={handleConfirm}
          >
            {translate('auto.components.sidebar.SpaceDeleteDialog.confirm', 'Delete Space')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
