import {
  ArrowLeft,
  ArrowRight,
  CircleStop,
  FolderOpen,
  GitBranch,
  Lightbulb,
  Loader2,
  Server
} from 'lucide-react'
import type { Dispatch, SetStateAction } from 'react'
import { Button } from '@/components/ui/button'
import { NestedRepoChecklist } from '@/components/repo/NestedRepoChecklist'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { NestedRepoScanResult } from '../../../../shared/types'
import { NestedRepoScanLimitNotice } from '../repo/NestedRepoScanLimitNotice'
import { getRuntimePathBasename } from '../../../../shared/cross-platform-path'
import { translate } from '@/i18n/i18n'

type RepoStepProps = {
  cloneUrl: string
  onCloneUrlChange: (value: string) => void
  nestedScan: NestedRepoScanResult | null
  nestedScanInProgress: boolean
  nestedSelectedPaths: Set<string>
  onNestedSelectedPathsChange: Dispatch<SetStateAction<Set<string>>>
  onImportNested: () => void
  onCancelNested: () => void
  onStopNestedScan: () => void
  onOpenFolder: () => void
  onOpenServerFolder: (kind: 'git' | 'folder') => void
  onClone: () => void
  onOpenSshSettings: () => void
  serverPath: string
  onServerPathChange: (value: string) => void
  cloneDestination: string
  onCloneDestinationChange: (value: string) => void
  workspaceDir: string
  runtimeActive: boolean
  busyLabel: string | null
  error: string | null
}

export function RepoStep({
  cloneUrl,
  onCloneUrlChange,
  nestedScan,
  nestedScanInProgress,
  nestedSelectedPaths,
  onNestedSelectedPathsChange,
  onImportNested,
  onCancelNested,
  onStopNestedScan,
  onOpenFolder,
  onOpenServerFolder,
  onClone,
  onOpenSshSettings,
  serverPath,
  onServerPathChange,
  cloneDestination,
  onCloneDestinationChange,
  workspaceDir,
  runtimeActive,
  busyLabel,
  error
}: RepoStepProps) {
  const disabled = Boolean(busyLabel)
  const nestedImportDisabled = disabled || nestedScanInProgress
  if (nestedScan) {
    const folderName = getRuntimePathBasename(nestedScan.selectedPath) || nestedScan.selectedPath
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-col gap-3">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-muted/30 p-5">
          <div className="flex min-w-0 shrink-0 items-center gap-4">
            <div className="grid size-11 shrink-0 place-items-center rounded-lg bg-muted text-foreground">
              <FolderOpen className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-base font-semibold text-foreground">{translate("auto.components.onboarding.RepoStep.2d20200346", "Import repositories")}</div>
              <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
                {nestedScanInProgress ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="group text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive focus-visible:ring-destructive/40"
                        aria-label={translate("auto.components.onboarding.RepoStep.c3d9d44ca2", "Stop scan")}
                        title={translate("auto.components.onboarding.RepoStep.c7af322fc3", "Stop scanning")}
                        onClick={onStopNestedScan}
                      >
                        <Loader2 className="size-3.5 animate-spin text-annotation-highlight group-hover:hidden group-focus-visible:hidden" />
                        <CircleStop className="hidden size-3.5 group-hover:block group-focus-visible:block" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={4}>
                      {translate("auto.components.onboarding.RepoStep.e8fdb36338", "Scanning repositories. Click to stop.")}</TooltipContent>
                  </Tooltip>
                ) : null}
                <span className="min-w-0 truncate">
                  {translate("auto.components.onboarding.RepoStep.2e6438dd34", "{{value0}}Found {{value1}} {{value2}} in this folder.", { value0: nestedScanInProgress ? 'Scanning... ' : '', value1: nestedScan.repos.length, value2: nestedScan.repos.length === 1 ? 'repository' : 'repositories' })}
                </span>
              </div>
              <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {translate("auto.components.onboarding.RepoStep.cecd6593fa", "Scanned folder:")} {folderName} - {nestedScan.selectedPath}
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
          <div className="mt-4 flex shrink-0 flex-wrap items-center gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-lg px-3 py-3 text-sm text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-40"
              disabled={disabled && !nestedScanInProgress}
              onClick={onCancelNested}
            >
              <ArrowLeft className="size-3.5" />
              {translate("auto.components.onboarding.RepoStep.27ca610db1", "Back")}</button>
            <button
              type="button"
              className="ml-auto rounded-lg bg-primary px-4 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
              disabled={nestedImportDisabled || nestedSelectedPaths.size === 0}
              onClick={onImportNested}
            >
              {translate("auto.components.onboarding.RepoStep.2d20200346", "Import repositories")}</button>
          </div>
        </div>
        {busyLabel && (
          <div className="shrink-0 rounded-lg border border-blue-400/30 bg-blue-400/10 px-4 py-2.5 text-sm text-blue-700 dark:text-blue-200">
            {busyLabel}
          </div>
        )}
        {error && (
          <div className="shrink-0 rounded-lg border border-red-400/30 bg-red-400/10 px-4 py-2.5 text-sm text-red-700 dark:text-red-200">
            {error}
          </div>
        )}
      </div>
    )
  }
  return (
    <div className="space-y-3">
      {runtimeActive ? (
        <form
          className="rounded-lg border border-border bg-muted/30 p-5"
          onSubmit={(event) => {
            event.preventDefault()
            onOpenServerFolder('git')
          }}
        >
          <div className="flex items-center gap-4">
            <div className="grid size-11 shrink-0 place-items-center rounded-lg bg-muted text-foreground">
              <FolderOpen className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-base font-semibold text-foreground">{translate("auto.components.onboarding.RepoStep.8cab104e3c", "Open a server project")}</div>
              <div className="mt-0.5 text-[13px] text-muted-foreground">
                {translate("auto.components.onboarding.RepoStep.466108ab89", "Enter a path that exists on the runtime server.")}</div>
            </div>
          </div>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <input
              className="min-w-0 flex-1 rounded-lg border border-border bg-background px-4 py-3 font-mono text-sm text-foreground outline-none transition focus:border-foreground/50 focus:ring-2 focus:ring-foreground/15"
              placeholder={translate("auto.components.onboarding.RepoStep.2ebbc26343", "/home/user/project")}
              value={serverPath}
              disabled={disabled}
              spellCheck={false}
              onChange={(event) => onServerPathChange(event.target.value)}
            />
            <button
              type="submit"
              className="shrink-0 rounded-lg bg-primary px-4 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
              disabled={!serverPath.trim() || disabled}
            >
              {translate("auto.components.onboarding.RepoStep.3863747c56", "Add Git Project")}</button>
            <button
              type="button"
              className="shrink-0 rounded-lg border border-border bg-background px-4 py-3 text-sm font-medium text-foreground hover:bg-muted/60 disabled:opacity-40"
              disabled={!serverPath.trim() || disabled}
              onClick={() => onOpenServerFolder('folder')}
            >
              {translate("auto.components.onboarding.RepoStep.e8214aa632", "Open as Folder")}</button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          className="group w-full rounded-xl border border-border bg-muted/30 p-5 text-left transition hover:border-foreground/40 hover:bg-muted/60 focus:border-foreground/70 focus:bg-muted/40 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-foreground/25 disabled:opacity-60"
          disabled={disabled}
          autoFocus={!disabled}
          onClick={onOpenFolder}
        >
          <div className="flex min-w-0 items-center gap-4">
            <div className="grid size-11 shrink-0 place-items-center rounded-lg bg-muted text-foreground">
              <FolderOpen className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <div className="min-w-0 text-base font-semibold text-foreground">
                  {translate("auto.components.onboarding.RepoStep.f4e9c8dcf8", "Browse for a folder")}</div>
                <ArrowRight className="size-4 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-foreground" />
              </div>
              <div className="mt-0.5 text-[13px] text-muted-foreground">
                {translate("auto.components.onboarding.RepoStep.831524961f", "Choose any local directory, git repo or not.")}</div>
            </div>
          </div>
          <div className="ml-[3.75rem] mt-3 flex w-fit max-w-[calc(100%-3.75rem)] items-center gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-[12px] text-muted-foreground">
            <span className="grid size-6 shrink-0 place-items-center rounded-md border border-border bg-background text-foreground">
              <Lightbulb className="size-3.5" />
            </span>
            <span>{translate("auto.components.onboarding.RepoStep.6558d50c69", "Want to import many repos at once? Select the parent folder.")}</span>
          </div>
        </button>
      )}

      <form
        className="rounded-lg border border-border bg-muted/30 p-5"
        onSubmit={(e) => {
          e.preventDefault()
          onClone()
        }}
      >
        <div className="flex items-center gap-4">
          <div className="grid size-11 shrink-0 place-items-center rounded-lg bg-muted text-foreground">
            <GitBranch className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-base font-semibold text-foreground">{translate("auto.components.onboarding.RepoStep.132425a3e3", "Clone a repo")}</div>
            <div className="mt-0.5 text-[13px] text-muted-foreground">
              {translate("auto.components.onboarding.RepoStep.288d8444b7", "Paste an HTTPS or SSH URL.")}</div>
          </div>
        </div>
        <div className="mt-4 flex gap-2">
          <input
            className="min-w-0 flex-1 rounded-lg border border-border bg-background px-4 py-3 font-mono text-sm text-foreground outline-none transition focus:border-foreground/50 focus:ring-2 focus:ring-foreground/15"
            placeholder={translate("auto.components.onboarding.RepoStep.955134915e", "git@github.com:org/repo.git")}
            value={cloneUrl}
            disabled={disabled}
            onChange={(event) => onCloneUrlChange(event.target.value)}
          />
          <button
            type="submit"
            className="shrink-0 rounded-lg bg-primary px-5 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            disabled={!cloneUrl.trim() || (runtimeActive && !cloneDestination.trim()) || disabled}
          >
            {translate("auto.components.onboarding.RepoStep.7932e95f68", "Clone")}</button>
        </div>
        {runtimeActive && (
          <div className="mt-2 space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">
              {translate("auto.components.onboarding.RepoStep.24c7c8696c", "Clone into server path")}</label>
            <input
              className="w-full rounded-lg border border-border bg-background px-4 py-3 font-mono text-sm text-foreground outline-none transition focus:border-foreground/50 focus:ring-2 focus:ring-foreground/15"
              placeholder={translate("auto.components.onboarding.RepoStep.7ec3f48820", "/home/user")}
              value={cloneDestination}
              disabled={disabled}
              spellCheck={false}
              onChange={(event) => onCloneDestinationChange(event.target.value)}
            />
          </div>
        )}
      </form>

      <div className="flex flex-wrap items-center justify-between gap-3 px-1 pt-1 text-xs text-muted-foreground">
        <div className="flex min-w-0 items-center gap-2">
          <span>{translate("auto.components.onboarding.RepoStep.7b679207e4", "Workspace")}</span>
          <span className="truncate font-mono text-foreground">
            {runtimeActive ? translate("auto.components.onboarding.RepoStep.cf23006ba7", "Runtime server") : workspaceDir}
          </span>
        </div>
        {runtimeActive ? (
          <div className="flex items-center gap-1.5">
            <Server className="size-3.5" />
            <span>{translate("auto.components.onboarding.RepoStep.c33b190ca3", "Server paths only")}</span>
          </div>
        ) : (
          <button
            type="button"
            className="inline-flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
            disabled={disabled}
            onClick={onOpenSshSettings}
          >
            <Server className="size-3.5 shrink-0" />
            <span className="truncate">{translate("auto.components.onboarding.RepoStep.b7c4da0504", "SSH? Set hosts up in Settings")}</span>
            <ArrowRight className="size-3.5 shrink-0" />
          </button>
        )}
      </div>

      {busyLabel && (
        <div className="flex items-center gap-2 rounded-lg border border-blue-400/30 bg-blue-400/10 px-4 py-2.5 text-sm text-blue-700 dark:text-blue-200">
          <span className="min-w-0 flex-1">{busyLabel}</span>
          {nestedScanInProgress ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="group text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive focus-visible:ring-destructive/40"
                  aria-label={translate("auto.components.onboarding.RepoStep.c3d9d44ca2", "Stop scan")}
                  title={translate("auto.components.onboarding.RepoStep.c7af322fc3", "Stop scanning")}
                  onClick={onStopNestedScan}
                >
                  <Loader2 className="size-3.5 animate-spin text-annotation-highlight group-hover:hidden group-focus-visible:hidden" />
                  <CircleStop className="hidden size-3.5 group-hover:block group-focus-visible:block" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {translate("auto.components.onboarding.RepoStep.e8fdb36338", "Scanning repositories. Click to stop.")}</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-red-400/30 bg-red-400/10 px-4 py-2.5 text-sm text-red-700 dark:text-red-200">
          {error}
        </div>
      )}
    </div>
  )
}
