import React, { useCallback, useEffect, useState } from 'react'
import { Database, Play, RefreshCw, Square } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import type {
  WorktreeServiceRuntimeState,
  WorktreeServicesStatus
} from '../../../../shared/worktree-services'

const STATUS_BADGE_CLASS: Record<WorktreeServicesStatus, string> = {
  ready: 'border-emerald-500/25 bg-emerald-500/5 text-emerald-600 dark:text-emerald-300',
  provisioning: 'border-sky-500/25 bg-sky-500/5 text-sky-600 dark:text-sky-300',
  create_failed: 'border-red-500/25 bg-red-500/5 text-red-600 dark:text-red-300',
  destroy_failed: 'border-red-500/25 bg-red-500/5 text-red-600 dark:text-red-300'
}

const STATUS_LABEL: Record<WorktreeServicesStatus, () => string> = {
  ready: () => translate('auto.components.right.sidebar.ServicesPanel.statusReady', 'Ready'),
  provisioning: () =>
    translate('auto.components.right.sidebar.ServicesPanel.statusProvisioning', 'Provisioning'),
  create_failed: () =>
    translate('auto.components.right.sidebar.ServicesPanel.statusCreateFailed', 'Create failed'),
  destroy_failed: () =>
    translate('auto.components.right.sidebar.ServicesPanel.statusDestroyFailed', 'Destroy failed')
}

const RUN_STATE_DOT: Record<WorktreeServiceRuntimeState['runState'], string> = {
  running: 'bg-emerald-500',
  stopped: 'bg-rose-500',
  unknown: 'bg-muted-foreground/40'
}

const RUN_STATE_LABEL: Record<WorktreeServiceRuntimeState['runState'], () => string> = {
  running: () => translate('auto.components.right.sidebar.ServicesPanel.runRunning', 'Running'),
  stopped: () => translate('auto.components.right.sidebar.ServicesPanel.runStopped', 'Stopped'),
  unknown: () =>
    translate('auto.components.right.sidebar.ServicesPanel.runUnknown', 'No status command')
}

function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="px-3 pt-3 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  )
}

export default function ServicesPanel(): React.JSX.Element {
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const record = useAppStore((s) =>
    activeWorktreeId ? s.worktreeServicesRecords[activeWorktreeId] : undefined
  )
  const hydrateWorktreeServices = useAppStore((s) => s.hydrateWorktreeServices)
  const [retrying, setRetrying] = useState(false)
  const [runtime, setRuntime] = useState<WorktreeServiceRuntimeState[] | null>(null)
  const [probing, setProbing] = useState(false)
  const [pendingAction, setPendingAction] = useState<string | null>(null)

  const worktreeId = record?.worktreeId
  const refreshRuntime = useCallback(async (): Promise<void> => {
    if (!worktreeId) {
      return
    }
    setProbing(true)
    try {
      setRuntime(await window.api.worktreeServices.runtime({ worktreeId }))
    } catch {
      setRuntime(null)
    } finally {
      setProbing(false)
    }
  }, [worktreeId])

  useEffect(() => {
    setRuntime(null)
    void refreshRuntime()
  }, [refreshRuntime])

  if (!record) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-xs text-muted-foreground">
        <Database className="size-5 opacity-50" />
        <p>
          {translate(
            'auto.components.right.sidebar.ServicesPanel.emptyState',
            'No isolated services for this workspace.'
          )}
        </p>
        <p className="text-[11px] opacity-80">
          {translate(
            'auto.components.right.sidebar.ServicesPanel.emptyHint',
            'Declare services in orca.yaml and check "Isolated services" when creating a workspace.'
          )}
        </p>
      </div>
    )
  }

  const handleRetry = async (): Promise<void> => {
    setRetrying(true)
    try {
      await window.api.worktreeServices.retry({ worktreeId: record.worktreeId })
      await hydrateWorktreeServices()
      await refreshRuntime()
    } catch (error) {
      toast.error(
        translate(
          'auto.components.right.sidebar.ServicesPanel.retryFailed',
          'Retrying services provisioning failed: {{value0}}',
          { value0: String(error instanceof Error ? error.message : error).slice(0, 200) }
        )
      )
    } finally {
      setRetrying(false)
    }
  }

  const handleAction = async (action: 'start' | 'stop', serviceId?: string): Promise<void> => {
    setPendingAction(serviceId ? `${action}:${serviceId}` : action)
    try {
      const result = await window.api.worktreeServices.action({
        worktreeId: record.worktreeId,
        action,
        ...(serviceId ? { serviceId } : {})
      })
      if (!result.success) {
        toast.error(result.errors.join('; ').slice(0, 300))
      }
      await refreshRuntime()
    } catch (error) {
      toast.error(String(error instanceof Error ? error.message : error).slice(0, 200))
    } finally {
      setPendingAction(null)
    }
  }

  const contextKeys = new Set(
    ['ORCA_WORKTREE_SLUG', 'ORCA_SERVICE_SLOT'].concat(
      Array.from({ length: 10 }, (_, i) => `ORCA_PORT_${i}`)
    )
  )
  const recipeEnv = Object.entries(record.env).filter(([key]) => !contextKeys.has(key))
  const ports = Array.from({ length: 10 }, (_, i) => record.env[`ORCA_PORT_${i}`]).filter(Boolean)
  const anyStartable = (runtime ?? []).some((state) => state.canStart)
  const anyStoppable = (runtime ?? []).some((state) => state.canStop)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto text-xs">
      <div className="flex items-center justify-between gap-2 px-3 pt-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <Database className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{record.slug}</span>
        </div>
        <div className="flex items-center gap-1">
          <Badge
            variant="outline"
            className={cn('h-4 rounded px-1.5 text-[9px]', STATUS_BADGE_CLASS[record.status])}
          >
            {STATUS_LABEL[record.status]()}
          </Badge>
          <Button
            size="icon"
            variant="ghost"
            className="size-5"
            onClick={() => void refreshRuntime()}
            disabled={probing}
            title={translate(
              'auto.components.right.sidebar.ServicesPanel.refreshStatus',
              'Refresh service status'
            )}
          >
            <RefreshCw className={cn('size-3', probing && 'animate-spin')} />
          </Button>
        </div>
      </div>
      {record.error && (
        <p className="px-3 pt-1 text-[11px] text-destructive break-words">{record.error}</p>
      )}
      {record.status === 'create_failed' && (
        <div className="px-3 pt-2">
          <Button size="sm" variant="outline" onClick={handleRetry} disabled={retrying}>
            <RefreshCw className={cn('size-3', retrying && 'animate-spin')} />
            {translate(
              'auto.components.right.sidebar.ServicesPanel.retryProvisioning',
              'Retry provisioning'
            )}
          </Button>
        </div>
      )}

      {(anyStartable || anyStoppable) && (
        <div className="flex items-center gap-1.5 px-3 pt-2">
          {anyStartable && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleAction('start')}
              disabled={pendingAction !== null}
            >
              <Play className="size-3" />
              {translate('auto.components.right.sidebar.ServicesPanel.startAll', 'Start all')}
            </Button>
          )}
          {anyStoppable && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleAction('stop')}
              disabled={pendingAction !== null}
            >
              <Square className="size-3" />
              {translate('auto.components.right.sidebar.ServicesPanel.stopAll', 'Stop all')}
            </Button>
          )}
        </div>
      )}

      <SectionLabel>
        {translate('auto.components.right.sidebar.ServicesPanel.servicesSection', 'Services')}
      </SectionLabel>
      <ul className="space-y-1 px-3">
        {runtime !== null && runtime.length === 0 && (
          <li className="text-[11px] text-muted-foreground">
            {translate('auto.components.right.sidebar.ServicesPanel.noServices', 'No services.')}
          </li>
        )}
        {(runtime ?? []).map((state) => (
          <li key={state.serviceId} className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <span
                className={cn('size-[7px] shrink-0 rounded-full', RUN_STATE_DOT[state.runState])}
                title={RUN_STATE_LABEL[state.runState]()}
              />
              <span className="truncate font-mono text-[11px]">{state.serviceId}</span>
              <span className="truncate text-[11px] text-muted-foreground">{state.name}</span>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              {state.canStart && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-5"
                  onClick={() => void handleAction('start', state.serviceId)}
                  disabled={pendingAction !== null || state.runState === 'running'}
                  title={translate(
                    'auto.components.right.sidebar.ServicesPanel.startService',
                    'Start service'
                  )}
                >
                  <Play className="size-3" />
                </Button>
              )}
              {state.canStop && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-5"
                  onClick={() => void handleAction('stop', state.serviceId)}
                  disabled={pendingAction !== null || state.runState === 'stopped'}
                  title={translate(
                    'auto.components.right.sidebar.ServicesPanel.stopService',
                    'Stop service'
                  )}
                >
                  <Square className="size-3" />
                </Button>
              )}
            </div>
          </li>
        ))}
        {runtime === null &&
          record.serviceIds.map((id) => (
            <li key={id} className="truncate font-mono text-[11px] text-muted-foreground">
              {id}
            </li>
          ))}
      </ul>

      <SectionLabel>
        {translate('auto.components.right.sidebar.ServicesPanel.slotSection', 'Slot & ports')}
      </SectionLabel>
      <div className="px-3 text-[11px] text-muted-foreground">
        {translate('auto.components.right.sidebar.ServicesPanel.slotLabel', 'Slot {{value0}}', {
          value0: String(record.slot)
        })}
        {ports.length > 0 && (
          <span className="font-mono">
            {' '}
            · {ports.at(0)}–{ports.at(-1)}
          </span>
        )}
      </div>

      {recipeEnv.length > 0 && (
        <>
          <SectionLabel>
            {translate(
              'auto.components.right.sidebar.ServicesPanel.envSection',
              'Environment variables'
            )}
          </SectionLabel>
          <ul className="space-y-0.5 px-3 pb-3">
            {recipeEnv.map(([key, value]) => (
              <li key={key} className="break-all font-mono text-[11px]">
                <span className="text-muted-foreground">{key}=</span>
                {value}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
