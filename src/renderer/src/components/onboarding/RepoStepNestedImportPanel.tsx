import { ArrowLeft, CircleStop, FolderOpen, Loader2 } from 'lucide-react'
import { useEffect, useId, useState, type Dispatch, type SetStateAction } from 'react'
import { Button } from '@/components/ui/button'
import { NestedRepoChecklist } from '@/components/repo/NestedRepoChecklist'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import type { NestedRepoScanResult } from '../../../../shared/types'
import { getRuntimePathBasename } from '../../../../shared/cross-platform-path'
import { NestedRepoScanLimitNotice } from '../repo/NestedRepoScanLimitNotice'

type RepoStepNestedImportPanelProps = {
  nestedScan: NestedRepoScanResult
  nestedScanInProgress: boolean
  nestedSelectedPaths: Set<string>
  onNestedSelectedPathsChange: Dispatch<SetStateAction<Set<string>>>
  onImportNested: (mode: 'group' | 'separate', groupName: string) => void
  onCancelNested: () => void
  onStopNestedScan: () => void
  busyLabel: string | null
  error: string | null
  disabled: boolean
}

export function RepoStepNestedImportPanel({
  nestedScan,
  nestedScanInProgress,
  nestedSelectedPaths,
  onNestedSelectedPathsChange,
  onImportNested,
  onCancelNested,
  onStopNestedScan,
  busyLabel,
  error,
  disabled
}: RepoStepNestedImportPanelProps) {
  const folderName = getRuntimePathBasename(nestedScan.selectedPath) || nestedScan.selectedPath
  const groupNameInputId = useId()
  const [groupName, setGroupName] = useState(folderName)
  const [pendingImportMode, setPendingImportMode] = useState<'group' | 'separate' | null>(null)
  const nestedImportDisabled = disabled || nestedScanInProgress
  const importing = Boolean(busyLabel) && !nestedScanInProgress
  const showSeparateSpinner = importing && pendingImportMode === 'separate'
  const showGroupSpinner = importing && pendingImportMode === 'group'
  const nestedScanSummary = translate(
    'auto.components.onboarding.RepoStep.2e6438dd34',
    'Found {{value0}} {{value1}} in this folder.',
    {
      value0: nestedScan.repos.length,
      value1: nestedScan.repos.length === 1 ? 'repository' : 'repositories'
    }
  )
  const nestedScanStatus = nestedScanInProgress
    ? `${translate('auto.components.onboarding.RepoStep.220dd32d83', 'Scanning...')} ${nestedScanSummary}`
    : nestedScanSummary

  useEffect(() => {
    setGroupName(folderName)
  }, [folderName, nestedScan.selectedPath])

  useEffect(() => {
    if (!importing) {
      setPendingImportMode(null)
    }
  }, [importing])

  const handleImport = (mode: 'group' | 'separate'): void => {
    setPendingImportMode(mode)
    onImportNested(mode, groupName.trim() || folderName)
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-3">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-muted/30 p-5">
        <div className="flex min-w-0 shrink-0 items-center gap-4">
          <div className="grid size-11 shrink-0 place-items-center rounded-lg bg-muted text-foreground">
            <FolderOpen className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-base font-semibold text-foreground">
              {translate('auto.components.onboarding.RepoStep.2d20200346', 'Import repositories')}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
              {nestedScanInProgress ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="group text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive focus-visible:ring-destructive/40"
                      aria-label={translate(
                        'auto.components.onboarding.RepoStep.c3d9d44ca2',
                        'Stop scan'
                      )}
                      title={translate(
                        'auto.components.onboarding.RepoStep.c7af322fc3',
                        'Stop scanning'
                      )}
                      onClick={onStopNestedScan}
                    >
                      <Loader2 className="size-3.5 animate-spin text-annotation-highlight group-hover:hidden group-focus-visible:hidden" />
                      <CircleStop className="hidden size-3.5 group-hover:block group-focus-visible:block" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={4}>
                    {translate(
                      'auto.components.onboarding.RepoStep.e8fdb36338',
                      'Scanning repositories. Click to stop.'
                    )}
                  </TooltipContent>
                </Tooltip>
              ) : null}
              <span className="min-w-0 truncate">{nestedScanStatus}</span>
            </div>
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {translate('auto.components.onboarding.RepoStep.cecd6593fa', 'Scanned folder:')}{' '}
              {folderName} - {nestedScan.selectedPath}
            </div>
          </div>
        </div>
        <NestedRepoChecklist
          scan={nestedScan}
          selectedPaths={nestedSelectedPaths}
          onSelectedPathsChange={onNestedSelectedPathsChange}
          disabled={nestedImportDisabled}
          className="mt-4 flex-1"
        />
        {nestedScanInProgress ||
        nestedScan.truncated ||
        nestedScan.timedOut ||
        nestedScan.stopped ? (
          <div className="mt-2 shrink-0">
            <NestedRepoScanLimitNotice scan={nestedScan} />
          </div>
        ) : null}
        <div className="mt-4 shrink-0 space-y-3 rounded-md border border-border bg-background/60 p-3">
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium text-foreground">
              {translate('auto.components.onboarding.RepoStep.fb33359f69', 'Is this a monorepo?')}
            </p>
            <p className="text-xs leading-5 text-muted-foreground">
              {translate(
                'auto.components.onboarding.RepoStep.d75170194e',
                'Import them as a group if they belong together. Orca will group them and let you work from the parent folder.'
              )}
            </p>
          </div>
          <div className="min-w-0 space-y-1">
            <Label htmlFor={groupNameInputId} className="text-[11px] text-muted-foreground">
              {translate('auto.components.onboarding.RepoStep.39d51212cc', 'Group name')}
            </Label>
            <Input
              id={groupNameInputId}
              aria-label={translate('auto.components.onboarding.RepoStep.39d51212cc', 'Group name')}
              value={groupName}
              onChange={(event) => setGroupName(event.target.value)}
              disabled={nestedImportDisabled}
              className="h-9 min-w-0"
              placeholder={folderName}
            />
          </div>
        </div>
        <div className="mt-4 flex shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-lg px-3 py-3 text-sm text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-40"
            disabled={disabled && !nestedScanInProgress}
            onClick={onCancelNested}
          >
            <ArrowLeft className="size-3.5" />
            {translate('auto.components.onboarding.RepoStep.27ca610db1', 'Back')}
          </button>
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-4 py-3 text-sm font-medium text-foreground hover:bg-muted/60 disabled:opacity-40"
            disabled={nestedImportDisabled || nestedSelectedPaths.size === 0}
            onClick={() => handleImport('separate')}
          >
            {showSeparateSpinner ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {translate('auto.components.onboarding.RepoStep.aa0247680d', 'No, import separately')}
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            disabled={nestedImportDisabled || nestedSelectedPaths.size === 0}
            onClick={() => handleImport('group')}
          >
            {showGroupSpinner ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {translate('auto.components.onboarding.RepoStep.a0bc4d1f8e', 'Import as group')}
          </button>
        </div>
      </div>
      {busyLabel ? (
        <div className="shrink-0 rounded-lg border border-blue-400/30 bg-blue-400/10 px-4 py-2.5 text-sm text-blue-700 dark:text-blue-200">
          {busyLabel}
        </div>
      ) : null}
      {error ? (
        <div className="shrink-0 rounded-lg border border-red-400/30 bg-red-400/10 px-4 py-2.5 text-sm text-red-700 dark:text-red-200">
          {error}
        </div>
      ) : null}
    </div>
  )
}
