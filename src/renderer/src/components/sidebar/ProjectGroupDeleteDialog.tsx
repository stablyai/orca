import React, { useCallback, useId, useRef, useState } from 'react'
import { Check } from 'lucide-react'
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
import { cn } from '@/lib/utils'

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
  const projectLabel = projectCount === 1 ? 'project' : 'projects'
  const removeContainedProjectCopy = translate(
    'auto.components.sidebar.ProjectGroupDeleteDialog.e8e48d9e7b',
    'Remove {{value0}} contained {{value1}}',
    { value0: projectCount, value1: projectLabel }
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
            <button
              type="button"
              role="checkbox"
              aria-checked={removeContainedProjects}
              aria-describedby={`${removeProjectsId}-description`}
              disabled={deleting}
              onClick={() => onRemoveContainedProjectsChange(!removeContainedProjects)}
              className={cn(
                'flex w-full items-start gap-2 rounded-sm px-1 py-1 text-left text-foreground/85 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                deleting && 'cursor-not-allowed opacity-70'
              )}
            >
              <span
                className={cn(
                  'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm border transition-colors',
                  removeContainedProjects
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-muted-foreground bg-transparent'
                )}
              >
                {removeContainedProjects ? <Check className="size-3" strokeWidth={3} /> : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{removeContainedProjectCopy}</span>
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
            </button>
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
