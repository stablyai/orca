import { type Dispatch, type SetStateAction } from 'react'
import { ArrowLeft, CircleStop, FolderTree, Loader2 } from 'lucide-react'
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { NestedRepoTreePreview } from '@/components/repo/NestedRepoTreePreview'
import type { NestedRepoScanResult } from '../../../../shared/types'
import { NestedRepoScanLimitNotice } from '../repo/NestedRepoScanLimitNotice'

type AddRepoNestedImportStepProps = {
  scan: NestedRepoScanResult
  groupName: string
  selectedPaths: Set<string>
  isAdding: boolean
  scanInProgress: boolean
  onGroupNameChange: (value: string) => void
  onSelectedPathsChange: Dispatch<SetStateAction<Set<string>>>
  onBack: () => void
  onImport: (mode: 'group' | 'separate') => void
  onStopScan: () => void
}

export function AddRepoNestedImportStep({
  scan,
  groupName,
  selectedPaths,
  isAdding,
  scanInProgress,
  onGroupNameChange,
  onSelectedPathsChange,
  onBack,
  onImport,
  onStopScan
}: AddRepoNestedImportStepProps): React.JSX.Element {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Import as project group</DialogTitle>
        <div className="flex min-w-0 items-center gap-1.5">
          {scanInProgress ? <AddRepoNestedImportStopButton onStopScan={onStopScan} /> : null}
          <DialogDescription className="min-w-0 truncate">
            {`${scanInProgress ? 'Scanning... ' : ''}Found ${scan.repos.length} git ${
              scan.repos.length === 1 ? 'repository' : 'repositories'
            } in this folder.`}
          </DialogDescription>
        </div>
      </DialogHeader>

      <div className="flex min-h-0 min-w-0 max-w-full flex-col gap-3 overflow-hidden pt-1">
        <div className="flex min-w-0 max-w-full items-center gap-3 overflow-hidden rounded-md border border-border bg-muted/30 p-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
            <FolderTree className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-foreground">
              Group under {groupName}
            </div>
            <div className="truncate text-[11px] text-muted-foreground">{scan.selectedPath}</div>
          </div>
        </div>

        <div className="min-w-0 space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground">Group name</label>
          <Input
            value={groupName}
            onChange={(event) => onGroupNameChange(event.target.value)}
            disabled={scanInProgress}
            className="h-9"
          />
        </div>

        <NestedRepoTreePreview
          scan={scan}
          selectedPaths={selectedPaths}
          onSelectedPathsChange={onSelectedPathsChange}
          disabled={isAdding || scanInProgress}
          className="flex-1"
        />
        {scanInProgress || scan.truncated || scan.timedOut || scan.stopped ? (
          <NestedRepoScanLimitNotice scan={scan} />
        ) : null}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button onClick={onBack} disabled={isAdding && !scanInProgress} variant="ghost">
            <ArrowLeft className="size-3.5" />
            Back
          </Button>
          <div className="ml-auto flex min-w-0 flex-wrap justify-end gap-2">
            <Button
              onClick={() => onImport('separate')}
              disabled={isAdding || scanInProgress || selectedPaths.size === 0}
              variant="outline"
            >
              Import separately
            </Button>
            <Button
              onClick={() => onImport('group')}
              disabled={isAdding || scanInProgress || selectedPaths.size === 0 || !groupName.trim()}
            >
              Import as project group
            </Button>
          </div>
        </div>
      </div>
    </>
  )
}

function AddRepoNestedImportStopButton({
  onStopScan
}: {
  onStopScan: () => void
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="group text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive focus-visible:ring-destructive/40"
          aria-label="Stop scan"
          title="Stop scanning"
          onClick={onStopScan}
        >
          <Loader2 className="size-3.5 animate-spin text-annotation-highlight group-hover:hidden group-focus-visible:hidden" />
          <CircleStop className="hidden size-3.5 group-hover:block group-focus-visible:block" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        Scanning repositories. Click to stop.
      </TooltipContent>
    </Tooltip>
  )
}
