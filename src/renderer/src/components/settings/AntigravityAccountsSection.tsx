import { useCallback, useEffect, useState, type JSX } from 'react'
import { ExternalLink, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '../../store'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import type { AntigravityAccountStatus, RateLimitWindow } from '../../../../shared/rate-limit-types'
import { SearchableSetting } from './SearchableSetting'

const ANTIGRAVITY_CLI_DOCS_URL = 'https://www.antigravity.google/docs/cli/install'

function UsagePercentRow({ window }: { window: RateLimitWindow }): JSX.Element {
  return (
    <div className="flex items-center gap-2 text-xs">
      <Badge variant="secondary" className="tabular-nums">
        {Math.round(window.usedPercent)}%
      </Badge>
      {window.resetDescription ? (
        <span className="text-muted-foreground">
          {translate(
            'auto.components.settings.AntigravityAccountsSection.resets',
            'Resets {{when}}',
            { when: window.resetDescription }
          )}
        </span>
      ) : null}
    </div>
  )
}

export function AntigravityAccountsSection(): JSX.Element {
  const refreshRateLimits = useAppStore((s) => s.refreshRateLimits)
  const antigravityUsage = useAppStore((s) => s.rateLimits.antigravity)
  const [status, setStatus] = useState<AntigravityAccountStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const loadStatus = useCallback(async (): Promise<void> => {
    try {
      const next = await window.api.antigravityAccounts.getStatus()
      setStatus(next)
    } catch (error) {
      console.error('Failed to load Antigravity account status:', error)
      setStatus({
        signedIn: false,
        email: null,
        tokenFresh: false,
        error: error instanceof Error ? error.message : 'Unable to read Antigravity sign-in'
      })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus, antigravityUsage?.updatedAt])

  const handleRefreshUsage = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await refreshRateLimits()
      await loadStatus()
    } finally {
      setRefreshing(false)
    }
  }

  const signedIn = status?.signedIn === true
  const tokenFresh = status?.tokenFresh === true
  const usageBuckets = antigravityUsage?.buckets ?? []
  const sessionWindow = usageBuckets.length > 0 ? null : (antigravityUsage?.session ?? null)
  const weeklyWindow = usageBuckets.length > 0 ? null : (antigravityUsage?.weekly ?? null)
  const hasUsage = usageBuckets.length > 0 || sessionWindow !== null || weeklyWindow !== null
  const usageFailure =
    signedIn &&
    !hasUsage &&
    (antigravityUsage?.status === 'unavailable' ||
      antigravityUsage?.status === 'error' ||
      antigravityUsage?.status === 'ok')
      ? (antigravityUsage.error ??
        translate(
          'auto.components.settings.AntigravityAccountsSection.usageUnknown',
          'Orca found the Antigravity CLI sign-in but could not read a usage percentage.'
        ))
      : null

  return (
    <section id="accounts-antigravity" className="space-y-4 scroll-mt-6">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <AgentIcon agent="antigravity" size={16} />
            {translate('auto.components.settings.AntigravityAccountsSection.title', 'Antigravity')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.AntigravityAccountsSection.description',
              'Shows the Google sign-in from your Antigravity CLI session (~/.gemini/antigravity-cli).'
            )}
          </p>
        </div>
        <a
          href={ANTIGRAVITY_CLI_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {translate(
            'auto.components.settings.AntigravityAccountsSection.docs',
            'Antigravity CLI docs'
          )}
          <ExternalLink className="size-3" />
        </a>
      </div>

      <div
        className={cn(
          'flex items-start gap-3 rounded-lg border bg-muted/20 p-3',
          signedIn && tokenFresh ? 'border-border/60' : 'border-border/40'
        )}
      >
        <ShieldCheck
          className={cn(
            'mt-0.5 size-4 shrink-0',
            signedIn && tokenFresh ? 'text-foreground' : 'text-muted-foreground'
          )}
        />
        <div className="min-w-0 flex-1 space-y-1">
          {loading ? (
            <p className="text-xs text-muted-foreground">
              {translate('auto.components.settings.AntigravityAccountsSection.loading', 'Loading…')}
            </p>
          ) : signedIn ? (
            <>
              <p className="truncate text-xs font-medium">
                {status?.email ??
                  translate(
                    'auto.components.settings.AntigravityAccountsSection.signedIn',
                    'Signed in'
                  )}
              </p>
              <p className="text-xs text-muted-foreground">
                {tokenFresh
                  ? translate(
                      'auto.components.settings.AntigravityAccountsSection.signedInHint',
                      'Signed in. Orca reads the Antigravity CLI session stored on disk.'
                    )
                  : translate(
                      'auto.components.settings.AntigravityAccountsSection.expiredHint',
                      'Session expired — run agy on the computer running Orca and wait for it to start. If prompted, complete sign-in, then click Refresh usage. No chat message is needed.'
                    )}
              </p>
            </>
          ) : (
            <>
              <p className="text-xs font-medium">
                {translate(
                  'auto.components.settings.AntigravityAccountsSection.notSignedIn',
                  'Not signed in to Antigravity CLI'
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.AntigravityAccountsSection.signInHint',
                  'In a terminal, run agy and complete Google sign-in, then click Refresh usage here.'
                )}
              </p>
            </>
          )}
          {status?.error ? <p className="text-xs text-destructive">{status.error}</p> : null}
        </div>
        <Button
          variant="outline"
          size="xs"
          disabled={refreshing}
          onClick={() => void handleRefreshUsage()}
          className="shrink-0 gap-1"
        >
          {refreshing ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <RefreshCw className="size-3" />
          )}
          {translate(
            'auto.components.settings.AntigravityAccountsSection.refresh',
            'Refresh usage'
          )}
        </Button>
      </div>

      {usageBuckets.length > 0 ? (
        <SearchableSetting
          title={translate('auto.components.settings.AntigravityAccountsSection.usage', 'Usage')}
          description={translate(
            'auto.components.settings.AntigravityAccountsSection.sessionUsageHint',
            'Same 5-hour and weekly windows as agy /usage.'
          )}
          keywords={['antigravity', 'agy', 'usage', 'quota', 'google']}
        >
          <div className="space-y-2">
            {usageBuckets.map((bucket) => (
              <div key={bucket.name} className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  {bucket.name}
                </span>
                <UsagePercentRow window={bucket} />
              </div>
            ))}
          </div>
        </SearchableSetting>
      ) : sessionWindow || weeklyWindow ? (
        <>
          {sessionWindow ? (
            <SearchableSetting
              title={translate(
                'auto.components.settings.AntigravityAccountsSection.sessionUsage',
                'Session usage'
              )}
              description={translate(
                'auto.components.settings.AntigravityAccountsSection.sessionUsageHint',
                'Same 5-hour and weekly windows as agy /usage.'
              )}
              keywords={['antigravity', 'agy', 'usage', 'quota', 'google']}
            >
              <UsagePercentRow window={sessionWindow} />
            </SearchableSetting>
          ) : null}
          {weeklyWindow ? (
            <SearchableSetting
              title={translate(
                'auto.components.settings.AntigravityAccountsSection.weeklyUsage',
                'Weekly usage'
              )}
              description={translate(
                'auto.components.settings.AntigravityAccountsSection.weeklyUsageHint',
                'Weekly Antigravity CLI quota window.'
              )}
              keywords={['antigravity', 'agy', 'usage', 'quota', 'google']}
            >
              <UsagePercentRow window={weeklyWindow} />
            </SearchableSetting>
          ) : null}
        </>
      ) : usageFailure ? (
        <SearchableSetting
          title={translate('auto.components.settings.AntigravityAccountsSection.usage', 'Usage')}
          description={translate(
            'auto.components.settings.AntigravityAccountsSection.usageUnknown',
            'Orca found the Antigravity CLI sign-in but could not read a usage percentage.'
          )}
          keywords={['antigravity', 'agy', 'usage', 'quota', 'google']}
        >
          <p className="text-xs text-muted-foreground">{usageFailure}</p>
        </SearchableSetting>
      ) : null}
    </section>
  )
}
