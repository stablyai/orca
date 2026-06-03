import { useEffect, useId, useRef, useState, type ComponentType, type Ref } from 'react'
import { ChevronDown, CircleStop, Loader2 } from 'lucide-react'
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { getAddRepoLocalStartActions } from './add-repo-local-start-actions'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'

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

type AddRepoServerPathStartStepProps = {
  serverPath: string
  isAddingServerPath: boolean
  addProjectBusyLabel: string | null
  onServerPathChange: (path: string) => void
  onAddServerPath: (kind: 'git' | 'folder') => void
  onOpenCloneStep: () => void
  onOpenCreateStep: () => void
}

export function AddRepoServerPathStartStep({
  serverPath,
  isAddingServerPath,
  addProjectBusyLabel,
  onServerPathChange,
  onAddServerPath,
  onOpenCloneStep,
  onOpenCreateStep
}: AddRepoServerPathStartStepProps): React.JSX.Element {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Add a server project</DialogTitle>
        <DialogDescription>
          Add a Git repository or folder that already exists on the selected runtime server.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3 pt-2">
        <div className="space-y-1">
          <label
            htmlFor="server-project-path"
            className="text-[11px] font-medium text-muted-foreground block"
          >
            Server path
          </label>
          <Input
            id="server-project-path"
            value={serverPath}
            onChange={(event) => onServerPathChange(event.target.value)}
            placeholder="/home/user/project"
            className="h-11 text-sm font-mono"
            disabled={isAddingServerPath}
            autoFocus
            spellCheck={false}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button
            onClick={() => onAddServerPath('git')}
            disabled={!serverPath.trim() || isAddingServerPath}
            className="h-10"
          >
            Add Git Project
          </Button>
          <Button
            onClick={() => onAddServerPath('folder')}
            disabled={!serverPath.trim() || isAddingServerPath}
            variant="outline"
            className="h-10"
          >
            Open as Folder
          </Button>
        </div>
        {isAddingServerPath && addProjectBusyLabel ? (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 shrink-0 animate-spin" />
            <span>{addProjectBusyLabel}</span>
          </div>
        ) : null}
        <div className="flex items-center justify-center gap-4 pt-1">
          <button
            type="button"
            onClick={onOpenCloneStep}
            disabled={isAddingServerPath}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer rounded focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-40"
          >
            Clone into server path
          </button>
          <button
            type="button"
            onClick={onOpenCreateStep}
            disabled={isAddingServerPath}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer rounded focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-40"
          >
            Create on server
          </button>
        </div>
      </div>
    </>
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
  const [showMoreOptions, setShowMoreOptions] = useState(false)
  const moreOptionsId = useId()
  const browseActionRef = useRef<HTMLButtonElement | null>(null)
  const { primaryAction, secondaryAction, moreOptions } = getAddRepoLocalStartActions({
    isSshLikely,
    onBrowse,
    onOpenCloneStep,
    onOpenRemoteStep,
    onOpenCreateStep
  })
  const primaryIsBrowse = primaryAction.kind === 'browse'
  const secondaryIsBrowse = secondaryAction?.kind === 'browse'

  useEffect(() => {
    if (!isAdding) {
      browseActionRef.current?.focus()
    }
  }, [isAdding])

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add a project</DialogTitle>
        <DialogDescription>
          {repoCount === 0
            ? 'Add a project to get started with Orca.'
            : 'Add another project to manage with Orca.'}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3 pt-2">
        <AddRepoPrimaryStartAction
          icon={primaryAction.icon}
          title={primaryAction.title}
          description={primaryAction.description}
          disabled={isAdding}
          buttonRef={primaryIsBrowse ? browseActionRef : undefined}
          onClick={primaryAction.onClick}
        />

        {secondaryAction ? (
          <AddRepoCompactStartAction
            icon={secondaryAction.icon}
            title={secondaryAction.title}
            description={secondaryAction.description}
            disabled={isAdding}
            buttonRef={secondaryIsBrowse ? browseActionRef : undefined}
            onClick={secondaryAction.onClick}
          />
        ) : null}

        <Collapsible open={showMoreOptions} onOpenChange={setShowMoreOptions}>
          <div className="space-y-2">
            <CollapsibleTrigger asChild>
              <button
                type="button"
                aria-controls={moreOptionsId}
                disabled={isAdding}
                className="inline-flex h-8 w-fit items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-default disabled:opacity-40"
              >
                More options
                <ChevronDown
                  className={cn(
                    'size-3.5 transition-transform',
                    showMoreOptions ? 'rotate-180' : 'rotate-0'
                  )}
                />
              </button>
            </CollapsibleTrigger>

            <CollapsibleContent id={moreOptionsId} className="collapsible-height-content">
              <div className="overflow-hidden rounded-md border border-border bg-muted/30">
                {moreOptions.map((option, index) => (
                  <AddRepoMoreOption
                    key={option.title}
                    icon={option.icon}
                    title={option.title}
                    description={option.description}
                    disabled={isAdding}
                    onClick={option.onClick}
                    className={index === 0 ? '' : 'border-t border-border/70'}
                  />
                ))}
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>
      </div>

      {isAdding && addProjectBusyLabel ? (
        <AddRepoNestedScanProgressNotice
          busyLabel={addProjectBusyLabel}
          nestedScanInProgress={nestedScanInProgress}
          nestedScanId={nestedScanId}
          onStopNestedScan={onStopNestedScan}
        />
      ) : null}
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
    <span className="grid size-11 shrink-0 place-items-center rounded-md border border-border bg-muted text-foreground">
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

const AddRepoCompactStartAction = ({
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
    className="h-auto min-h-14 w-full justify-start gap-3 whitespace-normal px-3 py-3 text-left"
  >
    <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-background text-muted-foreground">
      <Icon className="size-4" />
    </span>
    <span className="min-w-0">
      <span className="block text-sm font-medium leading-5">{title}</span>
      <span className="mt-0.5 block text-xs font-normal leading-4 text-muted-foreground">
        {description}
      </span>
    </span>
  </Button>
)

function AddRepoMoreOption({
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
