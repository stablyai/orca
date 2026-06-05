import { useState, type ComponentType } from 'react'
import { FolderOpen, Globe, Lightbulb, Loader2, Server } from 'lucide-react'
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { RemoteFileBrowser } from './RemoteFileBrowser'

type AddRepoServerPathStartStepProps = {
  serverPath: string
  runtimeEnvironmentId: string | null | undefined
  isAddingServerPath: boolean
  addProjectBusyLabel: string | null
  onServerPathChange: (path: string) => void
  onAddServerPath: (kind: 'git' | 'folder') => void
  onOpenCloneStep: () => void
  onOpenCreateStep: () => void
}

export function AddRepoServerPathStartStep({
  serverPath,
  runtimeEnvironmentId,
  isAddingServerPath,
  addProjectBusyLabel,
  onServerPathChange,
  onAddServerPath,
  onOpenCloneStep,
  onOpenCreateStep
}: AddRepoServerPathStartStepProps): React.JSX.Element {
  const [browsing, setBrowsing] = useState(false)
  const [pathEntryOpen, setPathEntryOpen] = useState(false)

  if (browsing && runtimeEnvironmentId) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Browse server filesystem</DialogTitle>
          <DialogDescription>
            Navigate to a directory and click Select to choose it.
          </DialogDescription>
        </DialogHeader>
        <RemoteFileBrowser
          runtimeEnvironmentId={runtimeEnvironmentId}
          initialPath={serverPath || '~'}
          onSelect={(path) => {
            onServerPathChange(path)
            setBrowsing(false)
            setPathEntryOpen(true)
          }}
          onCancel={() => setBrowsing(false)}
        />
      </>
    )
  }

  if (!pathEntryOpen) {
    const disabled = isAddingServerPath || !runtimeEnvironmentId

    return (
      <>
        <DialogHeader>
          <DialogTitle>Add a project</DialogTitle>
          <DialogDescription>
            Add another project from the selected runtime server.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 pt-2">
          <div className="grid grid-cols-3 gap-2">
            <AddRepoServerStartAction
              icon={FolderOpen}
              title="Browse server"
              description="Existing project or folder"
              disabled={disabled}
              onClick={() => setBrowsing(true)}
            />
            <AddRepoServerStartAction
              icon={Globe}
              title="Clone from URL"
              description="Remote Git repository"
              disabled={disabled}
              onClick={onOpenCloneStep}
            />
            <AddRepoServerStartAction
              icon={Server}
              title="Create on server"
              description="New repo or folder"
              disabled={disabled}
              onClick={onOpenCreateStep}
            />
          </div>

          <div className="flex items-center gap-3 rounded-md border border-border bg-muted px-3 py-2.5 text-xs text-muted-foreground">
            <span className="grid size-7 shrink-0 place-items-center rounded-md bg-background text-foreground">
              <Lightbulb className="size-3.5" />
            </span>
            <span className="min-w-0">
              Want to import many repos at once? Browse to the parent folder.
            </span>
          </div>

          <button
            type="button"
            onClick={() => setPathEntryOpen(true)}
            disabled={disabled}
            className="mx-auto block rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-40"
          >
            Or enter a server path manually
          </button>
        </div>
      </>
    )
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Open server project</DialogTitle>
        <DialogDescription>
          Add a Git repository or folder that already exists on the selected runtime server.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3 pt-2">
        <div className="space-y-1">
          <label
            htmlFor="server-project-path"
            className="block text-[11px] font-medium text-muted-foreground"
          >
            Server path
          </label>
          <div className="flex gap-2">
            <Input
              id="server-project-path"
              value={serverPath}
              onChange={(event) => onServerPathChange(event.target.value)}
              placeholder="/home/user/project"
              className="h-11 min-w-0 flex-1 font-mono text-sm"
              disabled={isAddingServerPath}
              autoFocus
              spellCheck={false}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-11 w-11 shrink-0"
                  onClick={() => setBrowsing(true)}
                  disabled={isAddingServerPath || !runtimeEnvironmentId}
                  aria-label="Browse server filesystem"
                >
                  <FolderOpen className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                Browse server filesystem
              </TooltipContent>
            </Tooltip>
          </div>
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
        <button
          type="button"
          onClick={() => setPathEntryOpen(false)}
          disabled={isAddingServerPath}
          className="mx-auto block rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-40"
        >
          Back to add options
        </button>
      </div>
    </>
  )
}

type AddRepoServerStartActionProps = {
  icon: ComponentType<{ className?: string }>
  title: string
  description: string
  disabled: boolean
  onClick: () => void
}

function AddRepoServerStartAction({
  icon: Icon,
  title,
  description,
  disabled,
  onClick
}: AddRepoServerStartActionProps): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="outline"
      disabled={disabled}
      onClick={onClick}
      className="h-32 min-w-0 flex-col gap-3 whitespace-normal border-border/80 bg-background px-3 py-4 text-center"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground">
        <Icon className="size-5" />
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold leading-5 text-foreground">{title}</span>
        <span className="mt-0.5 block text-[11px] font-normal leading-4 text-muted-foreground">
          {description}
        </span>
      </span>
    </Button>
  )
}
