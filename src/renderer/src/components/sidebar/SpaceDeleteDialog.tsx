import React from 'react'
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
  getSpaceById,
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

  const [deleting, setDeleting] = React.useState(false)
  const [deleteFailed, setDeleteFailed] = React.useState(false)
  const confirmButtonRef = React.useRef<HTMLButtonElement>(null)
  const mountedRef = React.useRef(true)

  const spaceId = typeof modalData.spaceId === 'string' ? modalData.spaceId : null
  const space = spaceId ? (getSpaceById(spaces, spaceId) ?? null) : null
  const defaultSpaceName =
    getSpaceById(spaces, DEFAULT_SPACE_ID)?.name ?? DEFAULT_SPACE_FALLBACK_NAME
  const open = activeModal === 'delete-space' && space !== null && !isDefaultSpaceId(space.id)
  const projectCount = React.useMemo(
    () => (space ? repos.filter((repo) => isRepoInSpace(repo, space.id)).length : 0),
    [repos, space]
  )

  const handleContentRef = React.useCallback((node: HTMLDivElement | null): void => {
    mountedRef.current = node !== null
  }, [])

  const handleConfirm = React.useCallback(async () => {
    if (!space || deleting) {
      return
    }
    setDeleteFailed(false)
    setDeleting(true)
    const deleted = await deleteSpace(space.id)
    if (mountedRef.current) {
      if (deleted) {
        closeModal()
      } else {
        setDeleting(false)
        setDeleteFailed(true)
      }
    }
  }, [closeModal, deleteSpace, deleting, space])

  if (!open || !space) {
    return null
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !deleting) {
          closeModal()
        }
      }}
    >
      <DialogContent
        ref={handleContentRef}
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
        {deleteFailed ? (
          <p role="alert" className="text-xs text-destructive">
            {translate(
              'auto.components.sidebar.SpaceDeleteDialog.deleteFailed',
              "Couldn't delete the Space. Try again."
            )}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-xs"
            disabled={deleting}
            onClick={closeModal}
          >
            {translate('auto.components.sidebar.SpaceDeleteDialog.cancel', 'Cancel')}
          </Button>
          <Button
            ref={confirmButtonRef}
            type="button"
            variant="destructive"
            size="sm"
            className="text-xs"
            disabled={deleting}
            onClick={handleConfirm}
          >
            {translate('auto.components.sidebar.SpaceDeleteDialog.confirm', 'Delete Space')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
