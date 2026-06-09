import { useId, type Dispatch, type SetStateAction } from 'react'
import { CircleHelp, CircleStop, Loader2 } from 'lucide-react'
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { NestedRepoChecklist } from '@/components/repo/NestedRepoChecklist'
import type { NestedRepoScanResult } from '../../../../shared/types'
import { NestedRepoScanLimitNotice } from '../repo/NestedRepoScanLimitNotice'
import { getRuntimePathBasename } from '../../../../shared/cross-platform-path'

type AddRepoNestedImportStepProps = {
  scan: NestedRepoScanResult
  groupName: string
  selectedPaths: Set<string>
  isFirstRepoImport: boolean
  isAdding: boolean
  scanInProgress: boolean
  onGroupNameChange: (value: string) => void
  onSelectedPathsChange: Dispatch<SetStateAction<Set<string>>>
  onImport: (mode: 'group' | 'separate') => void
  onStopScan: () => void
}

export function AddRepoNestedImportStep({
  scan,
  groupName,
  selectedPaths,
  isFirstRepoImport,
  isAdding,
  scanInProgress,
  onGroupNameChange,
  onSelectedPathsChange,
  onImport,
  onStopScan
}: AddRepoNestedImportStepProps): React.JSX.Element {
  const folderName = getRuntimePathBasename(scan.selectedPath) || scan.selectedPath
  const groupNameInputId = useId()
  const repoCountLabel = `${scan.repos.length} ${
    scan.repos.length === 1 ? 'repository' : 'repositories'
  }`

  return (
    <>
      <DialogHeader>
        <DialogTitle>Import repositories from folder</DialogTitle>
        <div className="flex min-w-0 items-center gap-1.5">
          {scanInProgress ? <AddRepoNestedImportStopButton onStopScan={onStopScan} /> : null}
          <DialogDescription className="min-w-0 truncate">
            {scanInProgress ? 'Scanning... ' : null}
            Found {repoCountLabel} in{' '}
            <span className="font-mono text-[11px] text-foreground" title={scan.selectedPath}>
              {scan.selectedPath}
            </span>
            .
          </DialogDescription>
        </div>
      </DialogHeader>

      <div className="flex min-h-0 min-w-0 max-w-full flex-col gap-3 overflow-hidden pt-1">
        <NestedRepoChecklist
          scan={scan}
          selectedPaths={selectedPaths}
          onSelectedPathsChange={onSelectedPathsChange}
          disabled={isAdding || scanInProgress}
          className="flex-1"
        />
        {scanInProgress || scan.truncated || scan.timedOut || scan.stopped ? (
          <NestedRepoScanLimitNotice scan={scan} />
        ) : null}
        {/* Why: first-time import uses one flat action because it is easier for new users to understand. */}
        {!isFirstRepoImport ? (
          <div className="min-w-0 shrink-0 space-y-1">
            <div className="flex shrink-0 items-center gap-1">
              <Label htmlFor={groupNameInputId} className="text-[11px] text-muted-foreground">
                Group name
              </Label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label="What is a group name?"
                    className="size-5 text-muted-foreground hover:text-foreground"
                  >
                    <CircleHelp className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4} className="max-w-64">
                  Keeps these repos together in one group. Best for related repos like
                  microservices.
                </TooltipContent>
              </Tooltip>
            </div>
            <Input
              id={groupNameInputId}
              aria-label="Group name"
              value={groupName}
              onChange={(event) => onGroupNameChange(event.target.value)}
              disabled={isAdding || scanInProgress}
              className="h-9 min-w-0"
              placeholder={folderName}
            />
          </div>
        ) : null}
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          <Button
            onClick={() => onImport('separate')}
            disabled={isAdding || scanInProgress || selectedPaths.size === 0}
            variant={isFirstRepoImport ? 'default' : 'outline'}
          >
            {isFirstRepoImport ? 'Import' : 'Import separately'}
          </Button>
          {!isFirstRepoImport ? (
            <Button
              onClick={() => onImport('group')}
              disabled={isAdding || scanInProgress || selectedPaths.size === 0}
            >
              Import as group
            </Button>
          ) : null}
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
