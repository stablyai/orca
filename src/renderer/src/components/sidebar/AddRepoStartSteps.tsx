import { CircleStop, FolderOpen, Globe, Lightbulb, Loader2, Monitor } from 'lucide-react'
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

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

      <div className="grid grid-cols-3 gap-3 pt-2">
        <Button
          onClick={onBrowse}
          disabled={isAdding}
          variant="outline"
          className="h-auto py-5 px-2 flex flex-col items-center gap-2 text-center border-border/80"
        >
          <FolderOpen className="size-6 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">Browse folder</p>
            <p className="text-[11px] text-muted-foreground font-normal mt-0.5">
              Local Git project or folder
            </p>
          </div>
        </Button>

        <Button
          onClick={onOpenCloneStep}
          disabled={isAdding}
          variant="outline"
          className="h-auto py-5 px-2 flex flex-col items-center gap-2 text-center border-border/80"
        >
          <Globe className="size-6 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">Clone from URL</p>
            <p className="text-[11px] text-muted-foreground font-normal mt-0.5">
              Remote Git repository
            </p>
          </div>
        </Button>

        <Button
          onClick={onOpenRemoteStep}
          disabled={isAdding}
          variant="outline"
          className="h-auto py-5 px-2 flex flex-col items-center gap-2 text-center border-border/80"
        >
          <Monitor className="size-6 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">Remote project</p>
            <p className="text-[11px] text-muted-foreground font-normal mt-0.5">
              SSH connected target
            </p>
          </div>
        </Button>
      </div>

      {isAdding && addProjectBusyLabel ? (
        <AddRepoNestedScanProgressNotice
          busyLabel={addProjectBusyLabel}
          nestedScanInProgress={nestedScanInProgress}
          nestedScanId={nestedScanId}
          onStopNestedScan={onStopNestedScan}
        />
      ) : null}

      <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
        <span className="grid size-6 shrink-0 place-items-center rounded-md border border-border bg-background text-foreground">
          <Lightbulb className="size-3.5" />
        </span>
        <span>Want to import many repos at once? Select the parent folder.</span>
      </div>

      <div className="flex items-center justify-center pt-1">
        <button
          type="button"
          onClick={onOpenCreateStep}
          disabled={isAdding}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer rounded focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-40"
        >
          Or start a new project from scratch
        </button>
      </div>
    </>
  )
}
