import { useEffect, useRef, type ComponentType, type Ref } from 'react'
import { CircleStop, Loader2 } from 'lucide-react'
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { getAddRepoLocalStartActions } from './add-repo-local-start-actions'

type AddRepoNestedScanProgressNoticeProps = {
  busyLabel: string
  nestedScanInProgress: boolean
  nestedScanId: string | null
  onStopNestedScan: () => void
}

function AddRepoNestedScanProgressNotice({
  busyLabel,
  nestedScanInProgress,
  nestedScanId,
  onStopNestedScan
}: AddRepoNestedScanProgressNoticeProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
      <Loader2 className="size-3.5 shrink-0 animate-spin" />
      <span className="min-w-0 flex-1">{busyLabel}</span>
      {nestedScanInProgress && nestedScanId ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="group text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive focus-visible:ring-destructive/40"
              aria-label="Stop scan"
              title="Stop scanning"
              onClick={onStopNestedScan}
            >
              <Loader2 className="size-3.5 animate-spin text-annotation-highlight group-hover:hidden group-focus-visible:hidden" />
              <CircleStop className="hidden size-3.5 group-hover:block group-focus-visible:block" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            Scanning repositories. Click to stop.
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  )
}

type AddRepoLocalStartStepProps = {
  repoCount: number
  isSshLikely: boolean
  isAdding: boolean
  addProjectBusyLabel: string | null
  nestedScanInProgress: boolean
  nestedScanId: string | null
  onBrowse: () => void
  onOpenCloneStep: () => void
  onOpenRemoteStep: () => void
  onOpenCreateStep: () => void
  onStopNestedScan: () => void
}

export function AddRepoLocalStartStep({
  repoCount,
  isSshLikely,
  isAdding,
  addProjectBusyLabel,
  nestedScanInProgress,
  nestedScanId,
  onBrowse,
  onOpenCloneStep,
  onOpenRemoteStep,
  onOpenCreateStep,
  onStopNestedScan
}: AddRepoLocalStartStepProps): React.JSX.Element {
  const browseActionRef = useRef<HTMLButtonElement | null>(null)
  const { primaryAction, secondaryActions } = getAddRepoLocalStartActions({
    isSshLikely,
    onBrowse,
    onOpenCloneStep,
    onOpenRemoteStep,
    onOpenCreateStep
  })

  useEffect(() => {
    if (!isAdding) {
      browseActionRef.current?.focus()
    }
  }, [isAdding])

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add a project</DialogTitle>
        {repoCount === 0 ? (
          <DialogDescription>Add a project to get started with Orca.</DialogDescription>
        ) : null}
      </DialogHeader>

      <div className="space-y-3 pt-2">
        <AddRepoPrimaryStartAction
          icon={primaryAction.icon}
          title={primaryAction.title}
          description={primaryAction.description}
          disabled={isAdding}
          buttonRef={browseActionRef}
          onClick={primaryAction.onClick}
        />

        {/* Keep secondary entry methods always visible so they stay discoverable without an extra click. */}
        {/* Label clarifies the lighter-weight rows are alternate entry methods, not lesser features. */}
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Or add from…</p>
          {/* Match the primary card's surface (bg-background) so the group reads as the same family, not a recessed panel. */}
          <div className="overflow-hidden rounded-md border border-border/80 bg-background">
            {secondaryActions.map((action, index) => (
              <AddRepoSecondaryStartAction
                key={action.kind}
                icon={action.icon}
                title={action.title}
                description={action.description}
                disabled={isAdding}
                onClick={action.onClick}
                className={index === 0 ? '' : 'border-t border-border/70'}
              />
            ))}
          </div>
        </div>

        {isAdding && addProjectBusyLabel ? (
          <AddRepoNestedScanProgressNotice
            busyLabel={addProjectBusyLabel}
            nestedScanInProgress={nestedScanInProgress}
            nestedScanId={nestedScanId}
            onStopNestedScan={onStopNestedScan}
          />
        ) : null}
      </div>
    </>
  )
}

type AddRepoStartActionProps = {
  icon: ComponentType<{ className?: string }>
  title: string
  description: string
  disabled: boolean
  onClick: () => void
  buttonRef?: Ref<HTMLButtonElement>
}

const AddRepoPrimaryStartAction = ({
  icon: Icon,
  title,
  description,
  disabled,
  onClick,
  buttonRef
}: AddRepoStartActionProps): React.JSX.Element => (
  <Button
    ref={buttonRef}
    type="button"
    variant="outline"
    onClick={onClick}
    disabled={disabled}
    className="h-auto min-h-24 w-full justify-start gap-4 whitespace-normal border-border/80 bg-background px-4 py-4 text-left"
  >
    <span className="grid size-11 shrink-0 place-items-center rounded-md text-foreground">
      <Icon className="size-5" />
    </span>
    <span className="min-w-0">
      <span className="block text-sm font-semibold leading-5">{title}</span>
      <span className="mt-0.5 block text-xs font-normal leading-5 text-muted-foreground">
        {description}
      </span>
    </span>
  </Button>
)

function AddRepoSecondaryStartAction({
  icon: Icon,
  title,
  description,
  disabled,
  onClick,
  className
}: AddRepoStartActionProps & { className?: string }): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex min-h-[3.25rem] w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-default disabled:opacity-40',
        className
      )}
    >
      <span className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium leading-5 text-foreground">{title}</span>
        <span className="block text-xs leading-4 text-muted-foreground">{description}</span>
      </span>
    </button>
  )
}
