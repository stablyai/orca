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
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { AgentIcon } from '@/lib/agent-catalog'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { runtimeTargetEnvironmentId } from '@/runtime/runtime-client-target'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  useStructuredAgentSessionHostCapabilityState,
  type StructuredAgentSessionHostCapabilityState
} from '@/runtime/structured-agent-session-host-capability'
import { USAGE_ANALYTICS_RUNTIME_CAPABILITY } from '../../../../shared/account-runtime-capabilities'
import { isSameStatsHost } from '../../store/slices/stats'
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

function StatsHostUsageNotice({
  support
}: {
  support: StructuredAgentSessionHostCapabilityState
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-dashed border-border/60 bg-card/30 px-4 py-5 text-sm text-muted-foreground">
      {support === 'unsupported'
        ? translate(
            'auto.components.stats.StatsPane.hostUsageUpdateRequired',
            'This server runs an older Orca that cannot report token usage. Update Orca on the server to see its usage here.'
          )
        : translate(
            'auto.components.stats.StatsPane.hostUsageConnecting',
            'Connecting to this server. Its token usage appears once it answers.'
          )}
    </div>
  )
}

const LOCAL_STATS_HOST: RuntimeClientTarget = { kind: 'local' }

export function StatsPane({
  host = LOCAL_STATS_HOST
}: {
  /** Host chosen at the top of Settings; this computer when omitted. */
  host?: RuntimeClientTarget
}): React.JSX.Element {
  const summary = useAppStore((s) => s.statsSummary)
  const fetchStatsSummary = useAppStore((s) => s.fetchStatsSummary)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const setStatsHost = useAppStore((s) => s.setStatsHost)
  const hostEnvironmentId = runtimeTargetEnvironmentId(host)
  // Why: panes mount only once the store reads this host, so their first fetch goes to it.
  const hostReady = useAppStore((s) => isSameStatsHost(s.statsHost, host))
  const hostUsageSupport = useStructuredAgentSessionHostCapabilityState(
    host,
    USAGE_ANALYTICS_RUNTIME_CAPABILITY
  )
  // Why: Grok credits still come from this computer's status bar, so a server does not offer them.
  const usageOptions =
    hostEnvironmentId === null
      ? USAGE_ANALYTICS_OPTIONS
      : USAGE_ANALYTICS_OPTIONS.filter((option) => option.id !== 'grok')
  const [activeUsageTab, setActiveUsageTab] = useState<UsageTab>('overview')
  const activeUsageOption =
    usageOptions.find((option) => option.id === activeUsageTab) ?? usageOptions[0]

  useEffect(() => {
    setStatsHost(
      hostEnvironmentId === null
        ? { kind: 'local' }
        : { kind: 'environment', environmentId: hostEnvironmentId }
    )
  }, [hostEnvironmentId, setStatsHost])

  useEffect(() => {
    recordFeatureInteraction('usage-tracking')
  }, [recordFeatureInteraction])

  useEffect(() => {
    if (hostReady) {
      void fetchStatsSummary()
    }
  }, [fetchStatsSummary, hostEnvironmentId, hostReady])

  return (
    <div className="space-y-5">
      {summary ? (
        <div className="space-y-3">
          {summary.totalAgentsSpawned === 0 && summary.totalPRsCreated === 0 ? (
            <div className="flex min-h-[8rem] items-center justify-center rounded-lg border border-dashed border-border/60 bg-card/30 text-sm text-muted-foreground">
              {translate(
                'auto.components.stats.StatsPane.73ed07859c',
                'Start your first agent to begin tracking'
              )}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-3">
                <StatCard
                  label={translate('auto.components.stats.StatsPane.9dbec9e675', 'Agents spawned')}
                  value={summary.totalAgentsSpawned.toLocaleString()}
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
                  value={summary.totalPRsCreated.toLocaleString()}
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
      ) : null}

      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-foreground">
            {translate('auto.components.stats.StatsPane.c79f073d4c', 'Usage Analytics')}
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
              {usageOptions.map((option) => (
                <DropdownMenuItem key={option.id} onSelect={() => setActiveUsageTab(option.id)}>
                  <span className="flex min-w-0 items-center gap-2">
                    <UsageAnalyticsOptionIcon tab={option.id} />
                    <span className="truncate">{option.label}</span>
                  </span>
                  <Check
                    className={`ml-auto size-3.5 ${
                      activeUsageOption.id === option.id ? 'opacity-100' : 'opacity-0'
                    }`}
                    aria-hidden
                  />
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Why: the Stats section lives inside the scroll-tracked settings page. Keeping only the
            active panel mounted avoids hidden tab-content layout/focus churn that produced a visible
            vertical jitter below the usage card when switching disabled providers. */}
        <div>
          {!hostReady ? null : hostEnvironmentId !== null && hostUsageSupport !== 'supported' ? (
            <StatsHostUsageNotice support={hostUsageSupport} />
          ) : activeUsageOption.id === 'overview' ? (
            <UsageOverviewPane />
          ) : activeUsageOption.id === 'claude' ? (
            <ClaudeUsagePane />
          ) : activeUsageOption.id === 'codex' ? (
            <CodexUsagePane />
          ) : activeUsageOption.id === 'opencode' ? (
            <OpenCodeUsagePane />
          ) : activeUsageOption.id === 'muse' ? (
            <MuseUsagePane />
          ) : (
            <GrokUsagePane />
          )}
        </div>
      </div>
    </div>
  )
}
