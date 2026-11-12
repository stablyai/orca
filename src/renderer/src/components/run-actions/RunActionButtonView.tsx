import React from 'react'
import {
  ChevronDown,
  ExternalLink,
  Play,
  Plug,
  RotateCw,
  Share2,
  Square,
  SquareTerminal
} from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { RunActionRun, RunActionStatus } from '@/lib/run-actions/run-actions-store'
import type { OrcaRunAction } from '../../../../shared/orca-yaml-hook-types'
import type { WorkspacePort } from '../../../../shared/workspace-ports'

export function isRunLive(status: RunActionStatus | undefined): boolean {
  return status === 'running' || status === 'stopping'
}

// The shared focus outline (as in Button), so keyboard focus reads the same across the titlebar.
const FOCUS_OUTLINE =
  'outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus-ring'

/** Shape carries state as well as color: filled while running or failed, hollow once it ended. */
function StatusDot({ status }: { status: RunActionStatus | undefined }): React.JSX.Element | null {
  if (!status) {
    return null
  }
  return (
    <span
      aria-hidden
      data-run-status={status}
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        status === 'running' && 'bg-status-success',
        status === 'stopping' && 'bg-status-warning motion-safe:animate-pulse',
        status === 'failed' && 'bg-destructive',
        (status === 'exited' || status === 'stopped') && 'border border-muted-foreground'
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
        return t('runActions.status.finished', 'Finished')
      case 'failed':
        return run.exitCode === null
          ? t('runActions.status.failed', 'Failed')
          : t('runActions.status.failedWithCode', 'Failed (exit {{code}})', { code: run.exitCode })
      case undefined:
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
  /** Polite announcement of the latest run ending ("Web stopped"), or null. */
  announcement?: string | null
  onRun: (action: OrcaRunAction) => void
  onStop: (action: OrcaRunAction) => void
  onShowOutput: (run: RunActionRun) => void
  onOpenPorts: () => void
  onOpenPortInBrowser: (port: WorkspacePort) => void
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
  const stopping = run?.status === 'stopping'
  const name = { name: action.name }
  return (
    <>
      <div className="flex items-center gap-2 px-2 pt-2 text-xs font-medium">
        <StatusDot status={run?.status} />
        <span className="min-w-0 flex-1 truncate text-foreground">{action.name}</span>
        <span className="shrink-0 font-normal text-muted-foreground">{statusLabel(run)}</span>
      </div>
      <div
        className="truncate px-2 pb-1 font-mono text-[11px] text-muted-foreground"
        title={action.command}
      >
        {action.command}
      </div>
      {live ? (
        <>
          {/* Both wait while the run settles, so a second press can't race the first. */}
          <DropdownMenuItem
            disabled={stopping}
            aria-label={t('runActions.restartNamed', 'Restart {{name}}', name)}
            onSelect={() => onRun(action)}
          >
            <RotateCw className="size-3.5" />
            {t('runActions.restart', 'Restart')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={stopping}
            aria-label={t('runActions.stopNamed', 'Stop {{name}}', name)}
            onSelect={() => onStop(action)}
          >
            <Square className="size-3.5" />
            {t('runActions.stop', 'Stop')}
          </DropdownMenuItem>
        </>
      ) : (
        <DropdownMenuItem
          aria-label={
            run
              ? t('runActions.runAgainNamed', 'Run {{name}} again', name)
              : t('runActions.runNamed', 'Run {{name}}', name)
          }
          onSelect={() => onRun(action)}
        >
          <Play className="size-3.5" />
          {run ? t('runActions.runAgain', 'Run again') : t('runActions.run', 'Run')}
        </DropdownMenuItem>
      )}
      {run ? (
        <DropdownMenuItem
          aria-label={t('runActions.showOutputNamed', 'Show {{name}} output', name)}
          onSelect={() => onShowOutput(run)}
        >
          <SquareTerminal className="size-3.5" />
          {t('runActions.showOutput', 'Show output')}
        </DropdownMenuItem>
      ) : null}
    </>
  )
}

function PortItem({
  port,
  onOpenPorts,
  onOpenPortInBrowser
}: { port: WorkspacePort } & Pick<
  RunActionButtonViewProps,
  'onOpenPorts' | 'onOpenPortInBrowser'
>): React.JSX.Element {
  const t = useTranslate()
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Plug className="size-3.5" />
        <span className="font-mono">:{port.port}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {port.processName ?? ''}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuItem onSelect={() => onOpenPortInBrowser(port)}>
          <ExternalLink className="size-3.5" />
          {t('runActions.openInBrowser', 'Open in browser')}
        </DropdownMenuItem>
        {/* Forwarding and share links live in the Ports panel, next to this port. */}
        <DropdownMenuItem onSelect={onOpenPorts}>
          <Share2 className="size-3.5" />
          {t('runActions.shareInPorts', 'Share…')}
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
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
  announcement = null,
  onRun,
  onStop,
  onShowOutput,
  onOpenPorts,
  onOpenPortInBrowser
}: RunActionButtonViewProps): React.JSX.Element {
  const t = useTranslate()
  const primaryRun = runs[primary.id]
  const primaryLive = isRunLive(primaryRun?.status)
  const liveCount = Object.values(runs).filter((run) => isRunLive(run.status)).length
  const name = { name: primary.name }
  const primaryLabel =
    primaryRun?.status === 'running'
      ? t('runActions.runningShowOutput', '{{name}} is running. Show output', name)
      : primaryRun?.status === 'stopping'
        ? t('runActions.stoppingShowOutput', '{{name}} is stopping. Show output', name)
        : primaryRun?.status === 'failed'
          ? t('runActions.runLastFailed', 'Run {{name}}, last run failed', name)
          : t('runActions.runNamed', 'Run {{name}}', name)
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
            className={cn(
              'flex h-full items-center gap-1.5 rounded-l-md px-2 hover:bg-accent hover:text-foreground',
              FOCUS_OUTLINE
            )}
            onClick={onPrimaryClick}
            aria-label={primaryLabel}
          >
            {primaryRun ? <StatusDot status={primaryRun.status} /> : <Play className="size-3" />}
            <span className="max-w-32 truncate">{primary.name}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {primaryLive ? (
            <div className="flex flex-col">
              <span>{t('runActions.showOutputTooltip', 'Show {{name}} output', name)}</span>
              {shortcut ? (
                <span className="text-muted-foreground">
                  {t('runActions.shortcutRestarts', '{{shortcut}} restarts it', { shortcut })}
                </span>
              ) : null}
            </div>
          ) : shortcut ? (
            `${t('runActions.runNamed', 'Run {{name}}', name)} (${shortcut})`
          ) : (
            t('runActions.runNamed', 'Run {{name}}', name)
          )}
        </TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              'flex h-full min-w-6 items-center justify-center gap-1 rounded-r-md border-l border-border/60 px-1 hover:bg-accent hover:text-foreground',
              FOCUS_OUTLINE
            )}
            aria-label={
              liveCount > 0
                ? t('runActions.menuRunning', 'Run actions, {{count}} running', {
                    count: liveCount
                  })
                : t('runActions.menu', 'Run actions')
            }
          >
            {liveCount > 0 && !primaryLive ? <StatusDot status="running" /> : null}
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
          <DropdownMenuLabel>{t('runActions.ports', 'Ports')}</DropdownMenuLabel>
          {ports.length === 0 ? (
            <div className="px-2 pb-2 text-xs text-muted-foreground">
              {t('runActions.noPorts', 'No servers listening in this workspace yet.')}
            </div>
          ) : (
            ports
              .slice(0, 6)
              .map((port) => (
                <PortItem
                  key={port.id}
                  port={port}
                  onOpenPorts={onOpenPorts}
                  onOpenPortInBrowser={onOpenPortInBrowser}
                />
              ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement ?? ''}
      </span>
    </div>
  )
}
