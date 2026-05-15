import { useEffect, useState } from 'react'
import { Bot, Clock, GitPullRequest } from 'lucide-react'
import { useAppStore } from '../../store'
import { StatCard } from './StatCard'
import { ClaudeUsagePane } from './ClaudeUsagePane'
import { CodexUsagePane } from './CodexUsagePane'
import { UsageOverviewPane } from './UsageOverviewPane'
import type { SettingsSearchEntry } from '../settings/settings-search'
import { cn } from '@/lib/utils'

export const STATS_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Stats & Usage',
    description:
      'Orca stats plus combined Claude and Codex usage analytics, tokens, cache, models, and sessions.',
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

export function StatsPane(): React.JSX.Element {
  const summary = useAppStore((s) => s.statsSummary)
  const fetchStatsSummary = useAppStore((s) => s.fetchStatsSummary)
  const [activeUsageTab, setActiveUsageTab] = useState<'overview' | 'claude' | 'codex'>('overview')

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
          <div
            role="group"
            aria-label="Usage analytics provider"
            className="inline-flex w-fit items-center justify-center rounded-lg bg-muted p-[3px] text-muted-foreground"
          >
            {(['overview', 'claude', 'codex'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                aria-pressed={activeUsageTab === tab}
                onClick={() => setActiveUsageTab(tab)}
                className={cn(
                  'inline-flex h-8 items-center justify-center rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap transition-all',
                  activeUsageTab === tab
                    ? 'bg-background text-foreground shadow-sm dark:border-input dark:bg-input/30'
                    : 'text-foreground/60 hover:text-foreground dark:text-muted-foreground dark:hover:text-foreground'
                )}
              >
                {tab === 'overview' ? 'Overview' : tab === 'claude' ? 'Claude' : 'Codex'}
              </button>
            ))}
          </div>
        </div>

        {/* Why: the Stats section lives inside the scroll-tracked settings page. Keeping only the
            active panel mounted avoids hidden tab-content layout/focus churn that produced a visible
            vertical jitter below the usage card when switching disabled providers. */}
        <div>
          {activeUsageTab === 'overview' ? (
            <UsageOverviewPane />
          ) : activeUsageTab === 'claude' ? (
            <ClaudeUsagePane />
          ) : (
            <CodexUsagePane />
          )}
        </div>
      </div>
    </div>
  )
}
