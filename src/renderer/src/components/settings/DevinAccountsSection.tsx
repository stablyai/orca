import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '../../store'
import type { DevinAccountStatus, RateLimitWindow } from '../../../../shared/rate-limit-types'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { SearchableSetting } from './SearchableSetting'

const DEVIN_CLI_DOCS_URL = 'https://docs.devin.ai/work-with-devin/devin-cli'
const DEVIN_USAGE_KEYWORDS = ['devin', 'cognition', 'usage', 'quota', 'rate limit', 'status bar']

function DevinQuotaSetting({
  description,
  quotaWindow,
  title
}: {
  description: string
  quotaWindow: RateLimitWindow
  title: string
}): React.JSX.Element {
  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={DEVIN_USAGE_KEYWORDS}
      className="space-y-1"
    >
      <p className="text-xs font-medium">{title}</p>
      <div className="flex items-center gap-2 text-xs">
        <Badge variant="secondary">
          <span className="tabular-nums">{Math.round(quotaWindow.usedPercent)}%</span>
        </Badge>
        {quotaWindow.resetDescription ? (
          <span className="text-muted-foreground">
            {translate(
              'auto.components.settings.DevinAccountsSection.resetsAt',
              'Resets {{when}}',
              { when: quotaWindow.resetDescription }
            )}
          </span>
        ) : null}
      </div>
    </SearchableSetting>
  )
}

export function DevinAccountsSection(): React.JSX.Element {
  const refreshDevinRateLimits = useAppStore((state) => state.refreshDevinRateLimits)
  const devinUsage = useAppStore((state) => state.rateLimits.devin)
  const [status, setStatus] = useState<DevinAccountStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const loadStatus = useCallback(async (): Promise<void> => {
    try {
      setStatus(await window.api.devinAccounts.getStatus())
    } catch (error) {
      console.error('Failed to load Devin account status:', error)
      setStatus({
        signedIn: false,
        email: null,
        tokenFresh: false,
        plan: null,
        error: error instanceof Error ? error.message : 'Unable to read Devin sign-in'
      })
    } finally {
      setLoading(false)
    }
  }, [])

  // Why: sign-in freshness is derived from the last usage fetch — reload after one lands.
  useEffect(() => {
    void loadStatus()
  }, [loadStatus, devinUsage?.updatedAt])

  const handleRefreshUsage = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await refreshDevinRateLimits()
      await loadStatus()
    } finally {
      setRefreshing(false)
    }
  }

  const signedIn = status?.signedIn === true
  const tokenFresh = status?.tokenFresh === true
  const plan = status?.plan ?? null
  const dailyWindow = devinUsage?.session ?? null
  const weeklyWindow = devinUsage?.weekly ?? null
  // Why: a signed-in account with a live session and no percentage must say so —
  // a hidden row reads as healthy. An expired session is already explained above.
  const unknownUsageReason =
    signedIn &&
    tokenFresh &&
    !dailyWindow &&
    !weeklyWindow &&
    (devinUsage?.status === 'unavailable' || devinUsage?.status === 'error')
      ? (devinUsage.error ??
        translate(
          'auto.components.settings.DevinAccountsSection.unknownUsageReason',
          'Devin reported no quota percentage for this account.'
        ))
      : null

  return (
    <section id="accounts-devin" className="space-y-4 scroll-mt-6">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <AgentIcon agent="devin" size={16} />
            {translate('auto.components.settings.DevinAccountsSection.sectionTitle', 'Devin')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.DevinAccountsSection.sectionDescription',
              'Shows daily and weekly quota from your Devin CLI sign-in (credentials file written by devin login).'
            )}
          </p>
        </div>
        <a
          href={DEVIN_CLI_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {translate('auto.components.settings.DevinAccountsSection.cliDocsLink', 'Devin CLI docs')}
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
              {translate('auto.components.settings.DevinAccountsSection.loading', 'Loading…')}
            </p>
          ) : signedIn ? (
            <>
              <p className="truncate text-xs font-medium">
                {status?.email ??
                  translate('auto.components.settings.DevinAccountsSection.signedIn', 'Signed in')}
              </p>
              <p className="text-xs text-muted-foreground">
                {tokenFresh
                  ? translate(
                      'auto.components.settings.DevinAccountsSection.signedInDetail',
                      'Signed in. Orca reads the Devin CLI session stored on disk.'
                    )
                  : translate(
                      'auto.components.settings.DevinAccountsSection.sessionExpired',
                      'Session expired. Run devin on the computer running Orca and wait for it to start. If prompted, complete sign-in, then click Refresh usage.'
                    )}
              </p>
              {plan ? (
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'auto.components.settings.DevinAccountsSection.plan',
                    'Plan: {{plan}}',
                    { plan }
                  )}
                </p>
              ) : null}
            </>
          ) : (
            <>
              <p className="text-xs font-medium">
                {translate(
                  'auto.components.settings.DevinAccountsSection.notSignedIn',
                  'Not signed in to Devin CLI'
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.DevinAccountsSection.notSignedInHint',
                  'In a terminal, run devin login, then click Refresh usage here.'
                )}
              </p>
            </>
          )}
          {/* Why: a signed-in account's only error is the expiry the copy above already explains. */}
          {!signedIn && status?.error ? (
            <p className="text-xs text-destructive">{status.error}</p>
          ) : null}
        </div>
        <Button
          variant="outline"
          size="xs"
          disabled={refreshing}
          onClick={() => void handleRefreshUsage()}
          className="shrink-0"
        >
          {refreshing ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <RefreshCw className="size-3" />
          )}
          {translate('auto.components.settings.DevinAccountsSection.refreshUsage', 'Refresh usage')}
        </Button>
      </div>

      {dailyWindow ? (
        <DevinQuotaSetting
          title={translate(
            'auto.components.settings.DevinAccountsSection.dailyQuotaTitle',
            'Daily quota used'
          )}
          description={translate(
            'auto.components.settings.DevinAccountsSection.dailyQuotaDescription',
            'Same daily quota percentage as devin auth status in the terminal.'
          )}
          quotaWindow={dailyWindow}
        />
      ) : null}
      {weeklyWindow ? (
        <DevinQuotaSetting
          title={translate(
            'auto.components.settings.DevinAccountsSection.weeklyQuotaTitle',
            'Weekly quota used'
          )}
          description={translate(
            'auto.components.settings.DevinAccountsSection.weeklyQuotaDescription',
            'Same weekly quota percentage as devin auth status in the terminal.'
          )}
          quotaWindow={weeklyWindow}
        />
      ) : null}
      {unknownUsageReason ? (
        <SearchableSetting
          title={translate(
            'auto.components.settings.DevinAccountsSection.unknownUsageTitle',
            'Devin usage'
          )}
          description={translate(
            'auto.components.settings.DevinAccountsSection.unknownUsageDescription',
            'Why Devin quota is unknown for this account.'
          )}
          keywords={DEVIN_USAGE_KEYWORDS}
        >
          <p className="text-xs text-muted-foreground">{unknownUsageReason}</p>
        </SearchableSetting>
      ) : null}
    </section>
  )
}
