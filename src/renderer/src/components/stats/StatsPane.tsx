import { useEffect, useState } from 'react'
import { BarChart3, Bot, Check, ChevronDown, Clock, GitPullRequest } from 'lucide-react'
import { useAppStore } from '../../store'
import { StatCard } from './StatCard'
import { ClaudeUsagePane } from './ClaudeUsagePane'
import { CodexUsagePane } from './CodexUsagePane'
import { OpenCodeUsagePane } from './OpenCodeUsagePane'
import { UsageOverviewPane } from './UsageOverviewPane'
import type { SettingsSearchEntry } from '../settings/settings-search'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { AgentIcon } from '@/lib/agent-catalog'

export const STATS_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Stats & Usage',
    description:
      'Orca stats plus combined Claude, Codex, and OpenCode usage analytics, tokens, cache, models, and sessions.',
    keywords: [
      'stats',
      'usage',
      'statistics',
      'agents',
      'prs',
      'time',
      'tracking',
      'claude',
      'codex',
      'opencode',
      'tokens',
      'cache'
    ]
  }
]

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
  return `Tracking since ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
}

type UsageTab = 'overview' | 'claude' | 'codex' | 'opencode'

const USAGE_ANALYTICS_OPTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'opencode', label: 'OpenCode' }
] as const satisfies readonly { id: UsageTab; label: string }[]

function UsageAnalyticsOptionIcon({ tab }: { tab: UsageTab }): React.JSX.Element {
  if (tab === 'overview') {
    return <BarChart3 className="size-3.5 text-muted-foreground" />
  }
  return <AgentIcon agent={tab} size={14} />
}

export function StatsPane(): React.JSX.Element {
  const summary = useAppStore((s) => s.statsSummary)
  const fetchStatsSummary = useAppStore((s) => s.fetchStatsSummary)
  const [activeUsageTab, setActiveUsageTab] = useState<UsageTab>('overview')
  const activeUsageOption =
    USAGE_ANALYTICS_OPTIONS.find((option) => option.id === activeUsageTab) ??
    USAGE_ANALYTICS_OPTIONS[0]

  useEffect(() => {
    void fetchStatsSummary()
  }, [fetchStatsSummary])

  return (
    <div className="space-y-5">
      {summary ? (
        <div className="space-y-3">
          {summary.totalAgentsSpawned === 0 && summary.totalPRsCreated === 0 ? (
            <div className="flex min-h-[8rem] items-center justify-center rounded-lg border border-dashed border-border/60 bg-card/30 text-sm text-muted-foreground">
              Start your first agent to begin tracking
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-3">
                <StatCard
                  label="Agents spawned"
                  value={summary.totalAgentsSpawned.toLocaleString()}
                  icon={<Bot className="size-4" />}
                />
                <StatCard
                  label="Time agents worked"
                  value={formatDuration(summary.totalAgentTimeMs)}
                  icon={<Clock className="size-4" />}
                />
                <StatCard
                  label="PRs created"
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
          <h3 className="text-sm font-semibold text-foreground">Usage Analytics</h3>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="usage-provider-select"
                aria-label={`Usage analytics provider: ${activeUsageOption.label}`}
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
              {USAGE_ANALYTICS_OPTIONS.map((option) => (
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

        {/* Why: the Stats section lives inside the scroll-tracked settings page. Keeping only the
            active panel mounted avoids hidden tab-content layout/focus churn that produced a visible
            vertical jitter below the usage card when switching disabled providers. */}
        <div>
          {activeUsageTab === 'overview' ? (
            <UsageOverviewPane />
          ) : activeUsageTab === 'claude' ? (
            <ClaudeUsagePane />
          ) : activeUsageTab === 'codex' ? (
            <CodexUsagePane />
          ) : (
            <OpenCodeUsagePane />
          )}
        </div>
      </div>
    </div>
  )
}
