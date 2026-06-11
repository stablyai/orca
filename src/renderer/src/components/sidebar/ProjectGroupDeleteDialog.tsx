import React, { useCallback, useId, useRef, useState } from 'react'
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
import { translate } from '@/i18n/i18n'

type ProjectGroupDeleteDialogProps = {
  open: boolean
  groupName: string
  projectCount: number
  projectNames: string[]
  removeContainedProjects: boolean
  onRemoveContainedProjectsChange: (removeContainedProjects: boolean) => void
  onOpenChange: (open: boolean) => void
  onConfirm: () => Promise<void> | void
}

export function ProjectGroupDeleteDialog({
  open,
  groupName,
  projectCount,
  projectNames,
  removeContainedProjects,
  onRemoveContainedProjectsChange,
  onOpenChange,
  onConfirm
}: ProjectGroupDeleteDialogProps): React.JSX.Element {
  const [deleting, setDeleting] = useState(false)
  const [wasOpen, setWasOpen] = useState(open)
  const mountedRef = useRef(true)
  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  const removeProjectsId = useId()
  const removeContainedProjectCopy =
    projectCount === 1
      ? translate(
          'auto.components.sidebar.ProjectGroupDeleteDialog.removeContainedProjectSingular',
          'Remove 1 contained project'
        )
      : translate(
          'auto.components.sidebar.ProjectGroupDeleteDialog.removeContainedProjectPlural',
          'Remove {{value0}} contained projects',
          { value0: projectCount }
        )

  const handleDialogContentRef = useCallback((node: HTMLDivElement | null): void => {
    // Why: deleting can resolve after the dialog closes; the content ref keeps
    // late completions from mutating stale dialog state without an Effect.
    mountedRef.current = node !== null
  }, [])

  // Why: opening the dialog must clear a stale in-flight state before the
  // destructive button renders; an Effect would leave one disabled frame.
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open && deleting) {
      setDeleting(false)
    }
  }

  const handleConfirm = useCallback(async () => {
    if (deleting) {
      return
    }
    setDeleting(true)
    try {
      await onConfirm()
      if (mountedRef.current) {
        setDeleting(false)
        onOpenChange(false)
      }
    } catch (error) {
      console.error('Failed to delete project group:', error)
      if (mountedRef.current) {
        setDeleting(false)
      }
    }
  }, [deleting, onConfirm, onOpenChange])

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && deleting) {
          return
        }
        if (!nextOpen) {
          setDeleting(false)
        }
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent
        ref={handleDialogContentRef}
        className="max-w-sm sm:max-w-sm"
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          confirmButtonRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate(
              'auto.components.sidebar.ProjectGroupDeleteDialog.591f330288',
              'Delete Project Group'
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate('auto.components.sidebar.ProjectGroupDeleteDialog.69f5cb97d0', 'Delete')}{' '}
            <span className="break-all font-medium text-foreground">{groupName}</span>.
          </DialogDescription>
        </DialogHeader>
        {projectCount > 0 && (
          <div className="space-y-2 text-xs">
            {projectNames.length > 0 && (
              <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2">
                <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.05em] text-muted-foreground">
                  {translate(
                    'auto.components.sidebar.ProjectGroupDeleteDialog.0e0e6764af',
                    'Contained projects'
                  )}
                </div>
                <ul
                  className="min-w-0 space-y-0.5 text-foreground"
                  aria-label={translate(
                    'auto.components.sidebar.ProjectGroupDeleteDialog.0e0e6764af',
                    'Contained projects'
                  )}
                >
                  {projectNames.slice(0, 4).map((projectName, index) => (
                    <li key={`${projectName}:${index}`} className="truncate" title={projectName}>
                      {projectName}
                    </li>
                  ))}
                  {projectNames.length > 4 ? (
                    <li className="text-muted-foreground">
                      +{projectNames.length - 4}{' '}
                      {translate(
                        'auto.components.sidebar.ProjectGroupDeleteDialog.ad407c2d55',
                        'more'
                      )}
                    </li>
                  ) : null}
                </ul>
              </div>
            )}
            <div className="flex w-full items-start gap-2 rounded-sm px-1 py-1 text-foreground/85">
              <Checkbox
                id={removeProjectsId}
                checked={removeContainedProjects}
                disabled={deleting}
                onCheckedChange={(checked) => onRemoveContainedProjectsChange(checked === true)}
                aria-describedby={`${removeProjectsId}-description`}
                className="mt-0.5"
              />
              <span className="min-w-0 flex-1">
                <Label
                  htmlFor={removeProjectsId}
                  className="block cursor-pointer text-xs leading-4 font-medium"
                >
                  {removeContainedProjectCopy}
                </Label>
                <span
                  id={`${removeProjectsId}-description`}
                  className="mt-0.5 block text-muted-foreground"
                >
                  {translate(
                    'auto.components.sidebar.ProjectGroupDeleteDialog.55f75628c0',
                    'Project folders on disk are not deleted.'
                  )}
                </span>
              </span>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-xs"
            disabled={deleting}
            onClick={() => onOpenChange(false)}
          >
            {translate('auto.components.sidebar.ProjectGroupDeleteDialog.ca65b78f78', 'Cancel')}
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
            {deleting
              ? translate(
                  'auto.components.sidebar.ProjectGroupDeleteDialog.2c14ce677a',
                  'Deleting...'
                )
              : translate(
                  'auto.components.sidebar.ProjectGroupDeleteDialog.fec7e9c8ae',
                  'Delete Group'
                )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
