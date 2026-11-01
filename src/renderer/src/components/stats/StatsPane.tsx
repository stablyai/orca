import { useEffect, useState } from 'react'
import { BarChart3, Bot, Check, ChevronDown, Clock, GitPullRequest } from 'lucide-react'
import { useAppStore } from '../../store'
import { StatCard } from './StatCard'
import { ClaudeUsagePane } from './ClaudeUsagePane'
import { CodexUsagePane } from './CodexUsagePane'
import { GrokUsagePane } from './GrokUsagePane'
import { OpenCodeUsagePane } from './OpenCodeUsagePane'
import { MuseUsagePane } from './MuseUsagePane'
import { UsageOverviewPane } from './UsageOverviewPane'
import type { SettingsHostScope } from '../settings/settings-host-scope'
import { SettingsHostScopeUnavailableNotice } from '../settings/SettingsHostScopePicker'
import { isWebClientLocation } from '@/lib/web-client-location'
import {
  getUsageOwnerHostScope,
  useOwnerUsageRateLimits
} from '../status-bar/use-owner-usage-rate-limits'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { AgentIcon } from '@/lib/agent-catalog'
import { getIntlLocale, translate } from '@/i18n/i18n'
export { getStatsPaneSearchEntries } from './stats-search'

function formatDuration(ms: number): string {
  if (ms <= 0) {
    return '0m'
  }

  const totalMinutes = Math.floor(ms / 60_000)
  const totalHours = Math.floor(totalMinutes / 60)
  const totalDays = Math.floor(totalHours / 24)
  const remainingHours = totalHours % 24
  const remainingMinutes = totalMinutes % 60

  if (totalDays > 0) {
    return `${totalDays}d ${remainingHours}h`
  }
  if (totalHours > 0) {
    return `${totalHours}h ${remainingMinutes}m`
  }
  return `${totalMinutes}m`
}

function formatTrackingSince(timestamp: number | null): string {
  if (!timestamp) {
    return ''
  }
  const date = new Date(timestamp)
  return translate('auto.components.stats.StatsPane.trackingSince', 'Tracking since {{value0}}', {
    value0: date.toLocaleDateString(getIntlLocale(), {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    })
  })
}

type UsageTab = 'overview' | 'claude' | 'codex' | 'opencode' | 'muse' | 'grok'

const USAGE_ANALYTICS_OPTIONS = [
  {
    id: 'overview',
    get label() {
      return translate('auto.components.stats.StatsPane.b2cf4310ce', 'Overview')
    }
  },
  {
    id: 'claude',
    get label() {
      return translate('auto.components.stats.StatsPane.85457c02fe', 'Claude')
    }
  },
  {
    id: 'codex',
    get label() {
      return translate('auto.components.stats.StatsPane.7d26110cea', 'Codex')
    }
  },
  {
    id: 'opencode',
    get label() {
      return translate('auto.components.stats.StatsPane.1e696db2f6', 'OpenCode')
    }
  },
  {
    id: 'muse',
    get label() {
      return translate('auto.lib.agent.catalog.muse_label', 'Muse')
    }
  },
  {
    id: 'grok',
    get label() {
      return translate('auto.components.stats.StatsPane.grokUsageTab', 'Grok')
    }
  }
] as const satisfies readonly { id: UsageTab; label: string }[]

function UsageAnalyticsOptionIcon({ tab }: { tab: UsageTab }): React.JSX.Element {
  if (tab === 'overview') {
    return <BarChart3 className="size-3.5 text-muted-foreground" />
  }
  return <AgentIcon agent={tab} size={14} />
}

export function StatsPane({
  hostScope
}: { hostScope?: SettingsHostScope } = {}): React.JSX.Element {
  return hostScope?.available === false ? (
    <SettingsHostScopeUnavailableNotice />
  ) : (
    <OwnedStatsPane hostScope={hostScope} />
  )
}

function OwnedStatsPane({ hostScope }: { hostScope?: SettingsHostScope }): React.JSX.Element {
  const summary = useAppStore((s) => s.statsSummary)
  const fetchStatsSummary = useAppStore((s) => s.fetchStatsSummary)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const localRateLimits = useAppStore((state) => state.rateLimits)
  const environments = useAppStore((state) => state.runtimeEnvironments)
  const selectedHost =
    hostScope?.target.kind === 'local' && isWebClientLocation() && environments?.length === 1
      ? { kind: 'environment' as const, environmentId: environments[0].id }
      : hostScope?.target
  const { remoteOwner } = useOwnerUsageRateLimits(localRateLimits)
  const historyTarget = selectedHost ?? getUsageOwnerHostScope(remoteOwner)
  const remoteHistory = historyTarget.kind === 'environment' || isWebClientLocation()
  const historyOwnerLabel =
    historyTarget.kind === 'environment'
      ? (environments?.find((environment) => environment.id === historyTarget.environmentId)
          ?.name ??
        remoteOwner?.label ??
        historyTarget.environmentId)
      : translate('stats.usage.localHost', 'This device')
  const [activeUsageTab, setActiveUsageTab] = useState<UsageTab>('overview')
  const activeUsageOption =
    USAGE_ANALYTICS_OPTIONS.find(
      (option) => option.id === activeUsageTab && (!remoteHistory || option.id !== 'grok')
    ) ?? USAGE_ANALYTICS_OPTIONS[0]

  useEffect(() => {
    recordFeatureInteraction('usage-tracking')
    void fetchStatsSummary()
  }, [fetchStatsSummary, recordFeatureInteraction])

  return (
    <div className="@container space-y-5">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-foreground">
            {translate('stats.usage.history.detail', 'History detail')}
          </h3>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="usage-provider-select"
                aria-label={translate(
                  'auto.components.stats.StatsPane.42d3e0bdf7',
                  'Usage analytics provider: {{value0}}',
                  { value0: activeUsageOption.label }
                )}
                className="min-w-36 justify-between"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <UsageAnalyticsOptionIcon tab={activeUsageOption.id} />
                  <span className="truncate">{activeUsageOption.label}</span>
                </span>
                <ChevronDown className="ml-1 size-3.5 text-muted-foreground" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              {USAGE_ANALYTICS_OPTIONS.filter(
                (option) => !remoteHistory || option.id !== 'grok'
              ).map((option) => (
                <DropdownMenuItem key={option.id} onSelect={() => setActiveUsageTab(option.id)}>
                  <span className="flex min-w-0 items-center gap-2">
                    <UsageAnalyticsOptionIcon tab={option.id} />
                    <span className="truncate">{option.label}</span>
                  </span>
                  <Check
                    className={`ml-auto size-3.5 ${
                      activeUsageTab === option.id ? 'opacity-100' : 'opacity-0'
                    }`}
                    aria-hidden
                  />
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Mount only the active panel to avoid hidden layout/focus churn jittering the scroll-tracked settings page. */}
        <div>
          {activeUsageOption.id !== 'grok' ? (
            <div className="space-y-4">
              <UsageOverviewPane
                key={JSON.stringify([
                  historyTarget.kind,
                  historyTarget.kind === 'environment' ? historyTarget.environmentId : null,
                  activeUsageOption.id
                ])}
                target={historyTarget}
                ownerLabel={historyOwnerLabel}
                initialProvider={activeUsageOption.id === 'overview' ? 'all' : activeUsageOption.id}
              />
              {!remoteHistory && activeUsageOption.id !== 'overview' ? (
                <details className="rounded-lg border border-border p-4">
                  <summary className="cursor-pointer text-sm font-medium text-foreground">
                    {translate('stats.usage.history.providerDetails', 'Original provider view')}
                  </summary>
                  <p className="my-3 text-xs text-muted-foreground">
                    {translate(
                      'stats.usage.history.providerDetailsScope',
                      'This provider view has its own period and project filters. Account filters above apply to the historical ledger.'
                    )}
                  </p>
                  {activeUsageOption.id === 'claude' ? (
                    <ClaudeUsagePane />
                  ) : activeUsageOption.id === 'codex' ? (
                    <CodexUsagePane />
                  ) : activeUsageOption.id === 'opencode' ? (
                    <OpenCodeUsagePane />
                  ) : (
                    <MuseUsagePane />
                  )}
                </details>
              ) : null}
            </div>
          ) : (
            <GrokUsagePane />
          )}
        </div>
      </div>
      {summary ? (
        <details className="rounded-lg border border-border p-4">
          <summary className="cursor-pointer text-sm font-medium text-foreground">
            {translate('stats.usage.activity.title', 'Local Orca activity · since first launch')}
          </summary>
          <p className="mt-2 text-xs text-muted-foreground">
            {translate(
              'stats.usage.activity.scope',
              'Local Orca events only. These counters use a different source and lifetime period from the historical log scan.'
            )}
          </p>
          <div className="mt-3 space-y-3">
            {summary.totalAgentsSpawned === 0 && summary.totalPRsCreated === 0 ? (
              <div className="flex min-h-[8rem] items-center justify-center rounded-lg border border-dashed border-border/60 bg-card/30 text-sm text-muted-foreground">
                {translate(
                  'auto.components.stats.StatsPane.73ed07859c',
                  'Start your first agent to begin tracking'
                )}
              </div>
            ) : (
              <>
                <div className="grid gap-3 @sm:grid-cols-3">
                  <StatCard
                    label={translate(
                      'auto.components.stats.StatsPane.9dbec9e675',
                      'Agents spawned'
                    )}
                    value={summary.totalAgentsSpawned.toLocaleString(getIntlLocale())}
                    icon={<Bot className="size-4" />}
                  />
                  <StatCard
                    label={translate(
                      'auto.components.stats.StatsPane.1c96f433e2',
                      'Time agents worked'
                    )}
                    value={formatDuration(summary.totalAgentTimeMs)}
                    icon={<Clock className="size-4" />}
                  />
                  <StatCard
                    label={translate('auto.components.stats.StatsPane.a58aba506f', 'PRs created')}
                    value={summary.totalPRsCreated.toLocaleString(getIntlLocale())}
                    icon={<GitPullRequest className="size-4" />}
                  />
                </div>
                {formatTrackingSince(summary.firstEventAt) && (
                  <p className="px-1 text-xs text-muted-foreground">
                    {formatTrackingSince(summary.firstEventAt)}
                  </p>
                )}
              </>
            )}
          </div>
        </details>
      ) : null}
    </div>
  )
}
