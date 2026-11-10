import React from 'react'
import { ChevronDown, Play, Plug, RotateCw, Square, SquareTerminal } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { RunActionRun, RunActionStatus } from '@/lib/run-actions/run-actions-store'
import type { OrcaRunAction } from '../../../../shared/orca-yaml-hook-types'
import type { WorkspacePort } from '../../../../shared/workspace-ports'

export function isRunLive(status: RunActionStatus | undefined): boolean {
  return status === 'running' || status === 'stopping'
}

function StatusDot({ status }: { status: RunActionStatus | undefined }): React.JSX.Element | null {
  if (!status) {
    return null
  }
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        status === 'running' && 'bg-emerald-500',
        status === 'stopping' && 'bg-amber-500 motion-safe:animate-pulse',
        status === 'failed' && 'bg-destructive',
        (status === 'exited' || status === 'stopped') && 'bg-muted-foreground/50'
      )}
    />
  )
}

function useStatusLabel(): (run: RunActionRun | undefined) => string {
  const t = useTranslate()
  return (run) => {
    switch (run?.status) {
      case 'running':
        return t('runActions.status.running', 'Running')
      case 'stopping':
        return t('runActions.status.stopping', 'Stopping…')
      case 'stopped':
        return t('runActions.status.stopped', 'Stopped')
      case 'exited':
        return t('runActions.status.exited', 'Exited')
      case 'failed':
        return run.exitCode === null
          ? t('runActions.status.failed', 'Failed')
          : t('runActions.status.failedWithCode', 'Failed (exit {{code}})', { code: run.exitCode })
      default:
        return t('runActions.status.notRunning', 'Not running')
    }
  }
}

export type RunActionButtonViewProps = {
  actions: readonly OrcaRunAction[]
  primary: OrcaRunAction
  runs: Readonly<Record<string, RunActionRun>>
  ports: readonly WorkspacePort[]
  shortcut: string | null
  onRun: (action: OrcaRunAction) => void
  onStop: (action: OrcaRunAction) => void
  onShowOutput: (run: RunActionRun) => void
  onOpenPorts: () => void
}

function ActionRow({
  action,
  run,
  onRun,
  onStop,
  onShowOutput
}: {
  action: OrcaRunAction
  run: RunActionRun | undefined
} & Pick<RunActionButtonViewProps, 'onRun' | 'onStop' | 'onShowOutput'>): React.JSX.Element {
  const t = useTranslate()
  const statusLabel = useStatusLabel()
  const live = isRunLive(run?.status)
  return (
    <>
      <DropdownMenuLabel className="flex items-center gap-2 pt-2 text-xs font-medium">
        <StatusDot status={run?.status} />
        <span className="min-w-0 flex-1 truncate">{action.name}</span>
        <span className="shrink-0 font-normal text-muted-foreground">{statusLabel(run)}</span>
      </DropdownMenuLabel>
      <div
        className="truncate px-2 pb-1 font-mono text-[11px] text-muted-foreground"
        title={action.command}
      >
        {action.command}
      </div>
      {live ? (
        <>
          <DropdownMenuItem onSelect={() => onRun(action)}>
            <RotateCw className="size-3.5" />
            {t('runActions.restart', 'Restart')}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={run?.status === 'stopping'} onSelect={() => onStop(action)}>
            <Square className="size-3.5" />
            {t('runActions.stop', 'Stop')}
          </DropdownMenuItem>
        </>
      ) : (
        <DropdownMenuItem onSelect={() => onRun(action)}>
          <Play className="size-3.5" />
          {run ? t('runActions.runAgain', 'Run again') : t('runActions.run', 'Run')}
        </DropdownMenuItem>
      )}
      {run ? (
        <DropdownMenuItem onSelect={() => onShowOutput(run)}>
          <SquareTerminal className="size-3.5" />
          {t('runActions.showOutput', 'Show output')}
        </DropdownMenuItem>
      ) : null}
    </>
  )
}

/**
 * Titlebar control for run actions. The main button starts the primary action (or shows its
 * terminal while it runs); the menu holds every action, Stop/Restart, and the ports it opened.
 */
export function RunActionButtonView({
  actions,
  primary,
  runs,
  ports,
  shortcut,
  onRun,
  onStop,
  onShowOutput,
  onOpenPorts
}: RunActionButtonViewProps): React.JSX.Element {
  const t = useTranslate()
  const primaryRun = runs[primary.id]
  const primaryLive = isRunLive(primaryRun?.status)
  const anyLive = Object.values(runs).some((run) => isRunLive(run.status))
  const primaryLabel = primaryLive
    ? t('runActions.showRunning', 'Show {{name}}', { name: primary.name })
    : t('runActions.runNamed', 'Run {{name}}', { name: primary.name })
  const onPrimaryClick = (): void => {
    if (primaryRun && primaryLive) {
      onShowOutput(primaryRun)
    } else {
      onRun(primary)
    }
  }

  return (
    <div
      className="mr-2 flex h-6 items-center rounded-md border border-border/60 text-xs text-muted-foreground [-webkit-app-region:no-drag]"
      data-testid="run-action-button"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="flex h-full items-center gap-1.5 rounded-l-md px-2 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={onPrimaryClick}
            aria-label={primaryLabel}
          >
            {primaryLive ? <StatusDot status={primaryRun?.status} /> : <Play className="size-3" />}
            <span className="max-w-32 truncate">{primary.name}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {shortcut ? `${primaryLabel} (${shortcut})` : primaryLabel}
        </TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex h-full items-center gap-1 rounded-r-md border-l border-border/60 px-1 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-label={t('runActions.menu', 'Run actions')}
          >
            {anyLive && !primaryLive ? <StatusDot status="running" /> : null}
            <ChevronDown className="size-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          {actions.map((action, index) => (
            <React.Fragment key={action.id}>
              {index > 0 ? <DropdownMenuSeparator /> : null}
              <ActionRow
                action={action}
                run={runs[action.id]}
                onRun={onRun}
                onStop={onStop}
                onShowOutput={onShowOutput}
              />
            </React.Fragment>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs font-medium">
            {t('runActions.ports', 'Ports')}
          </DropdownMenuLabel>
          {ports.length === 0 ? (
            <div className="px-2 pb-2 text-xs text-muted-foreground">
              {t('runActions.noPorts', 'No servers listening in this workspace yet.')}
            </div>
          ) : (
            ports.slice(0, 6).map((port) => (
              <DropdownMenuItem key={port.id} onSelect={onOpenPorts}>
                <Plug className="size-3.5" />
                <span className="font-mono">:{port.port}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {port.processName ?? ''}
                </span>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
