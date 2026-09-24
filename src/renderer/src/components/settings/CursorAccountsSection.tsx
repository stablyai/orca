import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '../../store'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import type { CursorAccountStatus } from '../../../../shared/rate-limit-types'
import { SearchableSetting } from './SearchableSetting'

const CURSOR_USAGE_DASHBOARD_URL = 'https://cursor.com/dashboard/spending'
const SEARCH_KEYWORDS = ['cursor', 'usage', 'plan', 'spend', 'billing', 'rate limit']

function credentialSourceLabel(source: CursorAccountStatus['credentialSource']): string | null {
  if (source === 'keychain') {
    return translate(
      'auto.components.settings.CursorAccountsSection.source.keychain',
      'macOS Keychain (cursor-agent)'
    )
  }
  if (source === 'cli') {
    return translate(
      'auto.components.settings.CursorAccountsSection.source.cli',
      'Cursor CLI auth file'
    )
  }
  if (source === 'desktop') {
    return translate('auto.components.settings.CursorAccountsSection.source.desktop', 'Cursor IDE')
  }
  return null
}

export function CursorAccountsSection(): React.JSX.Element {
  const refreshRateLimits = useAppStore((s) => s.refreshRateLimits)
  const cursorUsage = useAppStore((s) => s.rateLimits.cursor)
  const [status, setStatus] = useState<CursorAccountStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const loadStatus = useCallback(async (): Promise<void> => {
    try {
      setStatus(await window.api.cursorAccounts.getStatus())
    } catch (error) {
      console.error('Failed to load Cursor account status:', error)
      setStatus({
        signedIn: false,
        email: null,
        displayName: null,
        credentialSource: null,
        planType: null,
        tokenFresh: false,
        error: error instanceof Error ? error.message : 'Unable to read Cursor sign-in'
      })
    } finally {
      setLoading(false)
    }
  }, [])

  // Why: after a background usage fetch, sign-in state may change — reload status then.
  useEffect(() => {
    void loadStatus()
  }, [loadStatus, cursorUsage?.updatedAt])

  // Why: the effect below already reloads status when the refresh lands a new
  // snapshot, and each load is a keychain read for an item Orca does not own.
  const handleRefreshUsage = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await refreshRateLimits()
    } finally {
      setRefreshing(false)
    }
  }

  const signedIn = status?.signedIn === true
  const tokenFresh = status?.tokenFresh === true
  const sourceLabel = credentialSourceLabel(status?.credentialSource ?? null)
  const pools = cursorUsage?.buckets ?? []
  const monthly = cursorUsage?.monthly ?? null
  // Why: hiding the row entirely leaves signed-in users with no explanation when
  // Cursor reports no allowance — never let unknown usage read as healthy.
  const unavailableReason =
    signedIn && pools.length === 0 && !monthly && cursorUsage?.status === 'unavailable'
      ? (cursorUsage.error ?? null)
      : null

  return (
    <section id="accounts-cursor" className="space-y-4 scroll-mt-6">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <AgentIcon agent="cursor" size={16} />
            {translate('auto.components.settings.CursorAccountsSection.title', 'Cursor')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.CursorAccountsSection.subtitle',
              'Shows your monthly Cursor plan usage from the sign-in already on this computer. Orca only reads it — it never changes your Cursor login.'
            )}
          </p>
        </div>
        <a
          href={CURSOR_USAGE_DASHBOARD_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {translate(
            'auto.components.settings.CursorAccountsSection.dashboardLink',
            'Cursor dashboard'
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
              {translate('auto.components.settings.CursorAccountsSection.loading', 'Loading…')}
            </p>
          ) : signedIn ? (
            <>
              <p className="truncate text-xs font-medium">
                {status?.email ??
                  status?.displayName ??
                  translate('auto.components.settings.CursorAccountsSection.signedIn', 'Signed in')}
              </p>
              <p className="text-xs text-muted-foreground">
                {tokenFresh
                  ? sourceLabel
                    ? translate(
                        'auto.components.settings.CursorAccountsSection.signedInFrom',
                        'Signed in. Orca reads the session stored in {{source}}.',
                        { source: sourceLabel }
                      )
                    : translate(
                        'auto.components.settings.CursorAccountsSection.signedInGeneric',
                        'Signed in. Orca reads the Cursor session stored on this computer.'
                      )
                  : translate(
                      'auto.components.settings.CursorAccountsSection.expired',
                      'Sign-in expired — run cursor-agent login on the computer running Orca, then click Refresh usage.'
                    )}
              </p>
            </>
          ) : (
            <>
              <p className="text-xs font-medium">
                {translate(
                  'auto.components.settings.CursorAccountsSection.signedOut',
                  'Not signed in to Cursor'
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.CursorAccountsSection.signedOutHelp',
                  'In a terminal, run cursor-agent login, then click Refresh usage here.'
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
          className="shrink-0"
        >
          {refreshing ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <RefreshCw className="size-3" />
          )}
          {translate(
            'auto.components.settings.CursorAccountsSection.refreshUsage',
            'Refresh usage'
          )}
        </Button>
      </div>

      {pools.length > 0 || monthly ? (
        <SearchableSetting
          title={translate(
            'auto.components.settings.CursorAccountsSection.usageTitle',
            'Monthly plan usage'
          )}
          description={translate(
            'auto.components.settings.CursorAccountsSection.usageDescription',
            'Cursor bills two pools that reset with your billing cycle, plus on-demand spend once they run out.'
          )}
          keywords={SEARCH_KEYWORDS}
        >
          <div className="space-y-1">
            {pools.map((pool) => (
              <div key={pool.name} className="flex items-center gap-2 text-xs">
                <Badge variant="secondary">
                  <span className="tabular-nums">{Math.round(pool.usedPercent)}%</span>
                </Badge>
                <span className="text-muted-foreground">{pool.name}</span>
              </div>
            ))}
            {monthly ? (
              <div className="flex items-center gap-2 text-xs">
                <Badge variant="secondary">
                  <span className="tabular-nums">{Math.round(monthly.usedPercent)}%</span>
                </Badge>
                <span className="text-muted-foreground">
                  {translate('auto.components.settings.CursorAccountsSection.planTotal', 'Plan')}
                </span>
              </div>
            ) : null}
            {(monthly ?? pools[0])?.resetDescription ? (
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.CursorAccountsSection.resets',
                  'Resets {{when}}',
                  { when: (monthly ?? pools[0])?.resetDescription ?? '' }
                )}
              </p>
            ) : null}
          </div>
        </SearchableSetting>
      ) : unavailableReason ? (
        <SearchableSetting
          title={translate('auto.components.settings.CursorAccountsSection.usageLabel', 'Usage')}
          description={translate(
            'auto.components.settings.CursorAccountsSection.noAllowance',
            'Cursor reported no usage allowance for this account.'
          )}
          keywords={SEARCH_KEYWORDS}
        >
          <p className="text-xs text-muted-foreground">{unavailableReason}</p>
        </SearchableSetting>
      ) : null}
    </section>
  )
}
