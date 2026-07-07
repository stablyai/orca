import React, { useState } from 'react'
import { Database, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import type { WorktreeServicesStatus } from '../../../../shared/worktree-services'

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

  const contextKeys = new Set(
    ['ORCA_WORKTREE_SLUG', 'ORCA_SERVICE_SLOT'].concat(
      Array.from({ length: 10 }, (_, i) => `ORCA_PORT_${i}`)
    )
  )
  const recipeEnv = Object.entries(record.env).filter(([key]) => !contextKeys.has(key))
  const ports = Array.from({ length: 10 }, (_, i) => record.env[`ORCA_PORT_${i}`]).filter(Boolean)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto text-xs">
      <div className="flex items-center justify-between gap-2 px-3 pt-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <Database className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{record.slug}</span>
        </div>
        <Badge
          variant="outline"
          className={cn('h-4 rounded px-1.5 text-[9px]', STATUS_BADGE_CLASS[record.status])}
        >
          {STATUS_LABEL[record.status]()}
        </Badge>
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

      <SectionLabel>
        {translate('auto.components.right.sidebar.ServicesPanel.servicesSection', 'Services')}
      </SectionLabel>
      <ul className="space-y-0.5 px-3">
        {record.serviceIds.map((id) => (
          <li key={id} className="truncate font-mono text-[11px]">
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
