import { useEffect, useId, useState, type Dispatch, type SetStateAction } from 'react'
import { CircleStop, Loader2 } from 'lucide-react'
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { NestedRepoChecklist } from '@/components/repo/NestedRepoChecklist'
import type { NestedRepoScanResult } from '../../../../shared/types'
import { NestedRepoScanLimitNotice } from '../repo/NestedRepoScanLimitNotice'
import { getRuntimePathBasename } from '../../../../shared/cross-platform-path'
import { translate } from '@/i18n/i18n'

type AddRepoNestedImportStepProps = {
  scan: NestedRepoScanResult
  groupName: string
  selectedPaths: Set<string>
  isAdding: boolean
  scanInProgress: boolean
  onGroupNameChange: (value: string) => void
  onSelectedPathsChange: Dispatch<SetStateAction<Set<string>>>
  onImport: (mode: 'group' | 'separate') => void
  onOpenAsFolder: () => void
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
  onImport,
  onOpenAsFolder,
  onStopScan
}: AddRepoNestedImportStepProps): React.JSX.Element {
  const folderName = getRuntimePathBasename(scan.selectedPath) || scan.selectedPath
  const groupNameInputId = useId()
  const [pendingImportMode, setPendingImportMode] = useState<
    'folder' | 'group' | 'separate' | null
  >(null)
  const noRepositoriesSelected = selectedPaths.size === 0
  const showOpenAsFolderSpinner = isAdding && pendingImportMode === 'folder'
  const showSeparateSpinner = isAdding && pendingImportMode === 'separate'
  const showGroupSpinner = isAdding && pendingImportMode === 'group'

  useEffect(() => {
    if (!isAdding) {
      setPendingImportMode(null)
    }
  }, [isAdding])

  const handleImport = (mode: 'group' | 'separate'): void => {
    setPendingImportMode(mode)
    onImport(mode)
  }
  const handleOpenAsFolder = (): void => {
    setPendingImportMode('folder')
    onOpenAsFolder()
  }
  const repoCountLabel =
    scan.repos.length === 1
      ? translate('auto.components.sidebar.AddRepoNestedImportStep.8401a7a0d0', '1 repository')
      : translate(
          'auto.components.sidebar.AddRepoNestedImportStep.d4f1df62ef',
          '{{value0}} repositories',
          { value0: scan.repos.length }
        )
  const foundSentence = translate(
    'auto.components.sidebar.AddRepoNestedImportStep.b4263a2ac4',
    'Found {{value0}} in {{value1}}.',
    {
      value0: repoCountLabel,
      value1: scan.selectedPath
    }
  )

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {translate(
            'auto.components.sidebar.AddRepoNestedImportStep.8db50afe1a',
            'Import repositories from folder'
          )}
        </DialogTitle>
        <div className="flex min-w-0 items-center gap-1.5">
          {scanInProgress ? <AddRepoNestedImportStopButton onStopScan={onStopScan} /> : null}
          <DialogDescription className="min-w-0 truncate">
            {scanInProgress
              ? translate(
                  'auto.components.sidebar.AddRepoNestedImportStep.24eda6c8b2',
                  'Scanning... {{value0}}',
                  { value0: foundSentence }
                )
              : foundSentence}
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
        <div className="min-w-0 shrink-0 space-y-1">
          <p className="text-sm font-medium text-foreground">
            {translate(
              'auto.components.sidebar.AddRepoNestedImportStep.fb33359f69',
              'Group these repositories?'
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.sidebar.AddRepoNestedImportStep.d75170194e',
              'Choose this if these projects belong together — a monorepo, or just a set of related repos. Orca will group them and let you work from the parent folder.'
            )}
          </p>
        </div>
        <div className="min-w-0 shrink-0 space-y-1">
          <div className="flex shrink-0 items-center gap-1">
            <Label htmlFor={groupNameInputId} className="text-[11px] text-muted-foreground">
              {translate(
                'auto.components.sidebar.AddRepoNestedImportStep.39d51212cc',
                'Group name'
              )}
            </Label>
          </div>
          <Input
            id={groupNameInputId}
            aria-label={translate(
              'auto.components.sidebar.AddRepoNestedImportStep.39d51212cc',
              'Group name'
            )}
            value={groupName}
            onChange={(event) => onGroupNameChange(event.target.value)}
            disabled={isAdding || scanInProgress}
            className="h-9 min-w-0"
            placeholder={folderName}
          />
        </div>
        {noRepositoriesSelected ? (
          <p className="shrink-0 text-xs text-muted-foreground">
            {translate(
              'auto.components.sidebar.AddRepoNestedImportStep.6149d5203f',
              'No repositories are selected. Open the parent folder instead to use editor, terminal, and search without Git features.'
            )}
          </p>
        ) : null}
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          {noRepositoriesSelected ? (
            <Button
              onClick={handleOpenAsFolder}
              disabled={isAdding || scanInProgress}
              variant="secondary"
            >
              {showOpenAsFolderSpinner ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {translate(
                'auto.components.sidebar.AddRepoNestedImportStep.e52454b7f6',
                'Open as Folder'
              )}
            </Button>
          ) : null}
          <Button
            onClick={() => handleImport('separate')}
            disabled={isAdding || scanInProgress || noRepositoriesSelected}
            variant="outline"
          >
            {showSeparateSpinner ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {translate(
              'auto.components.sidebar.AddRepoNestedImportStep.aa0247680d',
              'No, import separately'
            )}
          </Button>
          <Button
            onClick={() => handleImport('group')}
            disabled={isAdding || scanInProgress || noRepositoriesSelected}
          >
            {showGroupSpinner ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {translate(
              'auto.components.sidebar.AddRepoNestedImportStep.a0bc4d1f8e',
              'Yes, import as group'
            )}
          </Button>
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
          aria-label={translate(
            'auto.components.sidebar.AddRepoNestedImportStep.2f8298f3c3',
            'Stop scan'
          )}
          title={translate(
            'auto.components.sidebar.AddRepoNestedImportStep.a32bef9516',
            'Stop scanning'
          )}
          onClick={onStopScan}
        >
          <Loader2 className="size-3.5 animate-spin text-annotation-highlight group-hover:hidden group-focus-visible:hidden" />
          <CircleStop className="hidden size-3.5 group-hover:block group-focus-visible:block" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {translate(
          'auto.components.sidebar.AddRepoNestedImportStep.496f68cf8c',
          'Scanning repositories. Click to stop.'
        )}
      </TooltipContent>
    </Tooltip>
  )
}
