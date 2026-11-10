import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, Play, Plug, RotateCw, Square, SquareTerminal } from 'lucide-react'
import { useAppStore } from '@/store'
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
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { useWorktreeRuntimeTarget } from '@/runtime/rpc/targets/use-worktree-runtime-target'
import { workspacePortScanKeyForTarget } from '@/lib/workspace-ports/workspace-port-actions'
import { getWorkspacePortsByWorktreeId } from '@/lib/workspace-ports/workspace-port-groups'
import {
  loadWorktreeRunActions,
  pickPrimaryRunAction,
  type WorktreeRunActions
} from '@/lib/run-actions/run-action-config'
import { startRunAction, stopRunAction } from '@/lib/run-actions/run-action-controller'
import {
  useWorktreeRunActionRuns,
  type RunActionRun,
  type RunActionStatus
} from '@/lib/run-actions/run-actions-store'
import type { OrcaRunAction } from '../../../../shared/orca-yaml-hook-types'
import type { WorkspacePort } from '../../../../shared/workspace-ports'

const EMPTY_PORTS: WorkspacePort[] = []

function isLive(status: RunActionStatus | undefined): boolean {
  return status === 'running' || status === 'stopping'
}

/** Reloads on workspace switch and window focus, so an orca.yaml edit shows up without a restart. */
function useWorktreeRunActions(worktreeId: string | null): WorktreeRunActions | null {
  const [config, setConfig] = useState<{ worktreeId: string; value: WorktreeRunActions } | null>(
    null
  )
  useEffect(() => {
    if (!worktreeId) {
      return
    }
    let cancelled = false
    const load = (): void => {
      void loadWorktreeRunActions(worktreeId, { background: true }).then((value) => {
        if (!cancelled && value) {
          setConfig({ worktreeId, value })
        }
      })
    }
    load()
    window.addEventListener('focus', load)
    return () => {
      cancelled = true
      window.removeEventListener('focus', load)
    }
  }, [worktreeId])
  return config && config.worktreeId === worktreeId ? config.value : null
}

function useWorktreePorts(worktreeId: string): WorkspacePort[] {
  const target = useWorktreeRuntimeTarget(worktreeId)
  return useAppStore((s) =>
    target
      ? (getWorkspacePortsByWorktreeId(
          s.workspacePortScansByKey[workspacePortScanKeyForTarget(target)]
        ).get(worktreeId) ?? EMPTY_PORTS)
      : EMPTY_PORTS
  )
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

function focusRunTab(worktreeId: string, tabId: string): void {
  const state = useAppStore.getState()
  state.setActiveTabType('terminal', worktreeId)
  state.setActiveTab(tabId)
}

function openPortsPanel(): void {
  const state = useAppStore.getState()
  state.setRightSidebarOpen(true)
  state.setRightSidebarTab('ports')
}

function ActionRow({
  worktreeId,
  action,
  run,
  config
}: {
  worktreeId: string
  action: OrcaRunAction
  run: RunActionRun | undefined
  config: WorktreeRunActions
}): React.JSX.Element {
  const t = useTranslate()
  const statusLabel = useStatusLabel()
  const live = isLive(run?.status)
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
          <DropdownMenuItem onSelect={() => void startRunAction(worktreeId, action, config)}>
            <RotateCw className="size-3.5" />
            {t('runActions.restart', 'Restart')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={run?.status === 'stopping'}
            onSelect={() => void stopRunAction(worktreeId, action.id)}
          >
            <Square className="size-3.5" />
            {t('runActions.stop', 'Stop')}
          </DropdownMenuItem>
        </>
      ) : (
        <DropdownMenuItem onSelect={() => void startRunAction(worktreeId, action, config)}>
          <Play className="size-3.5" />
          {run ? t('runActions.runAgain', 'Run again') : t('runActions.run', 'Run')}
        </DropdownMenuItem>
      )}
      {run ? (
        <DropdownMenuItem onSelect={() => focusRunTab(worktreeId, run.tabId)}>
          <SquareTerminal className="size-3.5" />
          {t('runActions.showOutput', 'Show output')}
        </DropdownMenuItem>
      ) : null}
    </>
  )
}

/**
 * Titlebar control for orca.yaml run actions. The main button starts the primary action (or shows
 * its terminal while it runs); the menu holds every action, Stop/Restart, and the ports it opened.
 */
export function RunActionButton({ worktreeId }: { worktreeId: string }): React.JSX.Element | null {
  const t = useTranslate()
  const config = useWorktreeRunActions(worktreeId)
  const runs = useWorktreeRunActionRuns(worktreeId)
  const ports = useWorktreePorts(worktreeId)
  const shortcut = useShortcutLabel('workspace.run')
  const primary = useMemo(
    () => (config ? pickPrimaryRunAction(worktreeId, config.actions) : null),
    // Runs change which action is primary (the last one started).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config, worktreeId, runs]
  )
  const primaryRun = primary ? runs[primary.id] : undefined
  const anyLive = Object.values(runs).some((run) => isLive(run.status))

  const onPrimaryClick = useCallback(() => {
    if (!config || !primary) {
      return
    }
    if (primaryRun && isLive(primaryRun.status)) {
      focusRunTab(worktreeId, primaryRun.tabId)
      return
    }
    void startRunAction(worktreeId, primary, config)
  }, [config, primary, primaryRun, worktreeId])

  if (!config || !primary) {
    return null
  }

  const primaryLive = isLive(primaryRun?.status)
  const primaryLabel = primaryLive
    ? t('runActions.showRunning', 'Show {{name}}', { name: primary.name })
    : t('runActions.runNamed', 'Run {{name}}', { name: primary.name })

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
            className="flex h-full items-center rounded-r-md border-l border-border/60 px-1 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-label={t('runActions.menu', 'Run actions')}
          >
            {anyLive && !primaryLive ? <StatusDot status="running" /> : null}
            <ChevronDown className="size-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          {config.actions.map((action, index) => (
            <React.Fragment key={action.id}>
              {index > 0 ? <DropdownMenuSeparator /> : null}
              <ActionRow
                worktreeId={worktreeId}
                action={action}
                run={runs[action.id]}
                config={config}
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
              <DropdownMenuItem key={port.id} onSelect={openPortsPanel}>
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
