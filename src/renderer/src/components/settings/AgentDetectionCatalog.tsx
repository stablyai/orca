import { AlertTriangle, RefreshCw } from 'lucide-react'
import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { AgentCatalogRow, type AgentCatalogRowProps } from './AgentCatalogRow'
import { SettingsBadge, SettingsSubsectionHeader } from './SettingsFormControls'

export function AgentDetectionCatalog({
  detectedAgents,
  undetectedAgents,
  detectionPending,
  detectionFailed,
  isRefreshing,
  activeServerEnvironmentId,
  activeServerName,
  onRefresh,
  getRowProps
}: {
  detectedAgents: AgentCatalogEntry[]
  undetectedAgents: AgentCatalogEntry[]
  detectionPending: boolean
  detectionFailed: boolean
  isRefreshing: boolean
  activeServerEnvironmentId: string | null
  activeServerName: string | null
  onRefresh: () => void
  getRowProps: (agent: AgentCatalogEntry, isDetected: boolean) => AgentCatalogRowProps
}): React.JSX.Element {
  return (
    <>
      {detectedAgents.length === 0 && !detectionPending && !detectionFailed && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-dashed border-border/50 px-3 py-3 text-sm text-muted-foreground">
          <span>
            {translate(
              'auto.components.settings.AgentsPane.noAgentsDetected',
              'No agents detected. If one is installed, the probe may have timed out.'
            )}
          </span>
          <RefreshButton isRefreshing={isRefreshing} onRefresh={onRefresh} />
        </div>
      )}

      {detectedAgents.length > 0 && (
        <section className="space-y-3">
          <SettingsSubsectionHeader
            title={
              <span className="flex items-center gap-2">
                {translate('auto.components.settings.AgentsPane.02e0143be5', 'Installed')}
                <SettingsBadge tone="accent">
                  {detectedAgents.length}{' '}
                  {translate('auto.components.settings.AgentsPane.ed3e110e61', 'detected')}
                </SettingsBadge>
                {activeServerName ? (
                  <SettingsBadge tone="muted">
                    {translate('auto.components.settings.AgentsPane.03e1a5081a', 'on {{value0}}', {
                      value0: activeServerName
                    })}
                  </SettingsBadge>
                ) : null}
              </span>
            }
            action={
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={onRefresh}
                disabled={isRefreshing}
                title={
                  activeServerEnvironmentId
                    ? translate(
                        'auto.components.settings.AgentsPane.25a41a9aad',
                        'Re-detect agents installed on the active server'
                      )
                    : translate(
                        'auto.components.settings.AgentsPane.13647f9f80',
                        'Re-read your shell PATH and re-detect installed agents'
                      )
                }
                className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                <RefreshCw className={cn('size-3', isRefreshing && 'animate-spin')} />
                {isRefreshing
                  ? translate('auto.components.settings.AgentsPane.c9b33eb5c0', 'Refreshing…')
                  : translate('auto.components.settings.AgentsPane.0d9e293a02', 'Refresh')}
              </Button>
            }
          />
          <div className="divide-y divide-border/40">
            {detectedAgents.map((agent) => (
              <AgentCatalogRow key={agent.id} {...getRowProps(agent, true)} />
            ))}
          </div>
        </section>
      )}

      {undetectedAgents.length > 0 && (
        <section className="space-y-3">
          <SettingsSubsectionHeader
            title={
              <span className="flex items-center gap-2 text-muted-foreground">
                {translate(
                  'auto.components.settings.AgentsPane.e8da2af684',
                  'Available to install'
                )}
                <SettingsBadge tone="muted">
                  {undetectedAgents.length}{' '}
                  {translate('auto.components.settings.AgentsPane.024bd95089', 'agents')}
                </SettingsBadge>
              </span>
            }
          />
          <div className="divide-y divide-border/40">
            {undetectedAgents.map((agent) => (
              <AgentCatalogRow key={agent.id} {...getRowProps(agent, false)} />
            ))}
          </div>
        </section>
      )}

      {detectionPending && !detectionFailed && (
        <div className="flex items-center justify-center rounded-md border border-dashed border-border/50 py-6 text-sm text-muted-foreground">
          {translate(
            'auto.components.settings.AgentsPane.d83834f5e6',
            'Detecting installed agents…'
          )}
        </div>
      )}

      {detectionFailed && (
        <div className="flex items-start justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <span className="flex min-w-0 items-start gap-2">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            {translate(
              'auto.components.settings.AgentsPane.remoteDetectionFailed',
              'Couldn’t detect installed agents. Check the host connection and try again.'
            )}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onRefresh}
            className="h-6 shrink-0 gap-1.5 px-2 text-destructive hover:text-destructive"
          >
            <RefreshCw className="size-3" />
            {translate('auto.components.settings.AgentsPane.retryDetection', 'Retry')}
          </Button>
        </div>
      )}
    </>
  )
}

function RefreshButton({
  isRefreshing,
  onRefresh
}: {
  isRefreshing: boolean
  onRefresh: () => void
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      onClick={onRefresh}
      disabled={isRefreshing}
      className="h-7 shrink-0 gap-1.5 text-xs"
    >
      <RefreshCw className={cn('size-3', isRefreshing && 'animate-spin')} />
      {isRefreshing
        ? translate('auto.components.settings.AgentsPane.c9b33eb5c0', 'Refreshing…')
        : translate('auto.components.settings.AgentsPane.0d9e293a02', 'Refresh')}
    </Button>
  )
}
