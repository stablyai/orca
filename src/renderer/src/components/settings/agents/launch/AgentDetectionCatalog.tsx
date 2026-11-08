import { Fragment } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../../ui/button'
import { AgentCatalogRow, type AgentCatalogRowProps } from './AgentCatalogRow'
import { SettingsBadge } from '../../form-controls/SettingsFormControls'
import { SettingsGroupHeader } from '../../section-layout/SettingsGroup'
import { AGENTS_INSTALLED_SECTION_ID } from '../agents-search'

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
  const t = useTranslate()
  return (
    <>
      {detectedAgents.length === 0 && !detectionPending && !detectionFailed && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-dashed border-border/50 px-3 py-3 text-sm text-muted-foreground">
          <span>
            {t(
              'auto.components.settings.AgentsPane.noAgentsDetected',
              'No agents detected. If one is installed, the probe may have timed out.'
            )}
          </span>
          <RefreshButton isRefreshing={isRefreshing} onRefresh={onRefresh} />
        </div>
      )}

      {/* Focusable so "Choose per agent" can move focus here. One keyed list (not one SettingsGroup per
          section) so a row keeps its state, e.g. expanded setup, when it moves from available to installed. */}
      <section id={AGENTS_INSTALLED_SECTION_ID} tabIndex={-1} className="scroll-mt-8 outline-none">
        {[
          ...detectedAgents.map((agent) => ({ agent, installed: true })),
          ...undetectedAgents.map((agent) => ({ agent, installed: false }))
        ].map(({ agent, installed }, index) => {
          const sectionLength = installed ? detectedAgents.length : undetectedAgents.length
          const indexInSection = installed ? index : index - detectedAgents.length
          const firstInSection = indexInSection === 0
          const lastInSection = indexInSection === sectionLength - 1
          return (
            <Fragment key={agent.id}>
              {firstInSection ? (
                <SettingsGroupHeader
                  className={cn('mb-3', index > 0 && 'mt-8')}
                  title={
                    installed ? (
                      <span className="flex items-center gap-2">
                        {t('auto.components.settings.AgentsPane.02e0143be5', 'Installed')}
                        <SettingsBadge tone="accent">
                          {detectedAgents.length}{' '}
                          {t('auto.components.settings.AgentsPane.ed3e110e61', 'detected')}
                        </SettingsBadge>
                        {activeServerName ? (
                          <SettingsBadge tone="muted">
                            {t('auto.components.settings.AgentsPane.03e1a5081a', 'on {{value0}}', {
                              value0: activeServerName
                            })}
                          </SettingsBadge>
                        ) : null}
                      </span>
                    ) : (
                      <span className="flex items-center gap-2 text-muted-foreground">
                        {t(
                          'auto.components.settings.AgentsPane.e8da2af684',
                          'Available to install'
                        )}
                        <SettingsBadge tone="muted">
                          {undetectedAgents.length}{' '}
                          {t('auto.components.settings.AgentsPane.024bd95089', 'agents')}
                        </SettingsBadge>
                      </span>
                    )
                  }
                  action={
                    installed ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={onRefresh}
                        disabled={isRefreshing}
                        title={
                          activeServerEnvironmentId
                            ? t(
                                'auto.components.settings.AgentsPane.25a41a9aad',
                                'Re-detect agents installed on this server'
                              )
                            : t(
                                'auto.components.settings.AgentsPane.13647f9f80',
                                'Re-read your shell PATH and re-detect installed agents'
                              )
                        }
                        className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                      >
                        <RefreshCw className={cn('size-3', isRefreshing && 'animate-spin')} />
                        {isRefreshing
                          ? t('auto.components.settings.AgentsPane.c9b33eb5c0', 'Refreshing…')
                          : t('auto.components.settings.AgentsPane.0d9e293a02', 'Refresh')}
                      </Button>
                    ) : undefined
                  }
                />
              ) : null}
              <div
                className={cn(
                  'border-x border-border bg-card/50 px-5',
                  firstInSection && 'rounded-t-xl border-t',
                  lastInSection && 'rounded-b-xl border-b shadow-xs'
                )}
              >
                <div className={cn(!firstInSection && 'border-t border-border')}>
                  <AgentCatalogRow {...getRowProps(agent, installed)} />
                </div>
              </div>
            </Fragment>
          )
        })}
      </section>

      {detectionPending && !detectionFailed && (
        <div className="flex items-center justify-center rounded-md border border-dashed border-border/50 py-6 text-sm text-muted-foreground">
          {t('auto.components.settings.AgentsPane.d83834f5e6', 'Detecting installed agents…')}
        </div>
      )}

      {detectionFailed && (
        <div className="flex items-start justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <span className="flex min-w-0 items-start gap-2">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            {t(
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
            {t('auto.components.settings.AgentsPane.retryDetection', 'Retry')}
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
  const t = useTranslate()
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
        ? t('auto.components.settings.AgentsPane.c9b33eb5c0', 'Refreshing…')
        : t('auto.components.settings.AgentsPane.0d9e293a02', 'Refresh')}
    </Button>
  )
}
