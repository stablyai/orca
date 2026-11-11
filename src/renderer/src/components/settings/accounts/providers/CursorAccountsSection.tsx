import { useCallback, useEffect, useRef, useState } from 'react'
import { ExternalLink, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useAppStore } from '../../../../store/index'
import { Badge } from '../../../ui/badge'
import { Button } from '../../../ui/button'
import type { CursorAccountStatus } from '../../../../../../shared/rate-limit-types'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { openAppHttpLinkFromAnchor } from '@/lib/browser/navigation/app-http-link-open'
import { SettingsGroup } from '../../section-layout/SettingsGroup'

const CURSOR_USAGE_DASHBOARD_URL = 'https://cursor.com/dashboard/spending'
const SEARCH_KEYWORDS = ['cursor', 'usage', 'plan', 'spend', 'billing', 'rate limit']

function credentialSourceLabel(
  source: CursorAccountStatus['credentialSource'],
  t: Translate = translate
): string | null {
  if (source === 'keychain') {
    return t(
      'auto.components.settings.CursorAccountsSection.source.keychain',
      'macOS Keychain (cursor-agent)'
    )
  }
  if (source === 'cli') {
    return t('auto.components.settings.CursorAccountsSection.source.cli', 'Cursor CLI auth file')
  }
  if (source === 'desktop') {
    return t('auto.components.settings.CursorAccountsSection.source.desktop', 'Cursor IDE')
  }
  return null
}

export function CursorAccountsSection(): React.JSX.Element {
  const t = useTranslate()
  const refreshRateLimits = useAppStore((s) => s.refreshRateLimits)
  const cursorUsage = useAppStore((s) => s.rateLimits.cursor)
  const [status, setStatus] = useState<CursorAccountStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  // Reject overlapping usage reads that finish late with older account state.
  const latestLoad = useRef(0)

  const loadStatus = useCallback(async (): Promise<void> => {
    const generation = latestLoad.current + 1
    latestLoad.current = generation
    const apply = (next: CursorAccountStatus): void => {
      if (latestLoad.current !== generation) {
        return
      }
      setStatus(next)
      setLoading(false)
    }
    try {
      apply(await window.api.cursorAccounts.getStatus())
    } catch (error) {
      console.error('Failed to load Cursor account status:', error)
      apply({
        signedIn: false,
        email: null,
        displayName: null,
        credentialSource: null,
        planType: null,
        tokenFresh: false,
        error: error instanceof Error ? error.message : 'Unable to read Cursor sign-in'
      })
    }
  }, [])

  // Background usage updates can change sign-in state; reload status on arrival.
  useEffect(() => {
    void loadStatus()
  }, [loadStatus, cursorUsage?.updatedAt])

  // Let the snapshot effect reload status once; each extra read touches an externally owned keychain item.
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
  const sourceLabel = credentialSourceLabel(status?.credentialSource ?? null, t)
  const pools = cursorUsage?.buckets ?? []
  const monthly = cursorUsage?.monthly ?? null
  // Explain unknown/failed usage rather than hiding the signed-in account or implying healthy allowance.
  const unavailableReason =
    signedIn && pools.length === 0 && !monthly
      ? cursorUsage?.status === 'unavailable' || cursorUsage?.status === 'error'
        ? (cursorUsage.error ?? null)
        : null
      : null
  // Stale snapshots retain numbers; show their refresh failure beside them.
  const staleUsageError =
    signedIn && cursorUsage?.status === 'error' && (pools.length > 0 || monthly)
      ? (cursorUsage.error ?? null)
      : null

  return (
    <div id="accounts-cursor" className="scroll-mt-6">
      <SettingsGroup
        title={
          <span className="flex items-center gap-2">
            <AgentIcon agent="cursor" size={16} />
            {t('auto.components.settings.CursorAccountsSection.title', 'Cursor')}
          </span>
        }
        description={t(
          'auto.components.settings.CursorAccountsSection.subtitle',
          'Shows your Cursor plan usage from the sign-in already on this computer. Orca only reads it — it never changes your Cursor login.'
        )}
        action={
          <a
            href={CURSOR_USAGE_DASHBOARD_URL}
            target="_blank"
            onClick={openAppHttpLinkFromAnchor}
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {t('auto.components.settings.CursorAccountsSection.dashboardLink', 'Cursor dashboard')}
            <ExternalLink className="size-3" />
          </a>
        }
      >
        <div className="flex items-start gap-3 py-3">
          <ShieldCheck
            className={cn(
              'mt-0.5 size-4 shrink-0',
              signedIn && tokenFresh ? 'text-foreground' : 'text-muted-foreground'
            )}
          />
          <div className="min-w-0 flex-1 space-y-1">
            {loading ? (
              <p className="text-xs text-muted-foreground">
                {t('auto.components.settings.CursorAccountsSection.loading', 'Loading…')}
              </p>
            ) : signedIn ? (
              <>
                <p className="truncate text-xs font-medium">
                  {status?.email ??
                    status?.displayName ??
                    t('auto.components.settings.CursorAccountsSection.signedIn', 'Signed in')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {tokenFresh
                    ? sourceLabel
                      ? t(
                          'auto.components.settings.CursorAccountsSection.signedInFrom',
                          'Signed in. Orca reads the session stored in {{source}}.',
                          { source: sourceLabel }
                        )
                      : t(
                          'auto.components.settings.CursorAccountsSection.signedInGeneric',
                          'Signed in. Orca reads the Cursor session stored on this computer.'
                        )
                    : t(
                        'auto.components.settings.CursorAccountsSection.expired',
                        'Sign-in expired — run cursor-agent login on the computer running Orca, then click Refresh usage.'
                      )}
                </p>
              </>
            ) : (
              <>
                <p className="text-xs font-medium">
                  {t(
                    'auto.components.settings.CursorAccountsSection.signedOut',
                    'No Cursor sign-in found on this computer'
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t(
                    'auto.components.settings.CursorAccountsSection.signedOutHelp',
                    'Sign in with Cursor IDE, or run cursor-agent login in a terminal, then click Refresh usage here.'
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
            {t('auto.components.settings.CursorAccountsSection.refreshUsage', 'Refresh usage')}
          </Button>
        </div>

        {pools.length > 0 || monthly ? (
          <SearchableSetting
            title={t('auto.components.settings.CursorAccountsSection.usageTitle', 'Plan usage')}
            description={t(
              'auto.components.settings.CursorAccountsSection.usageDescription',
              'Cursor bills two pools that reset with your billing cycle, plus on-demand spend once they run out.'
            )}
            keywords={SEARCH_KEYWORDS}
            className="py-3"
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
                    {t('auto.components.settings.CursorAccountsSection.planTotal', 'Plan')}
                  </span>
                </div>
              ) : null}
              {(monthly ?? pools[0])?.resetDescription ? (
                <p className="text-xs text-muted-foreground">
                  {t('auto.components.settings.CursorAccountsSection.resets', 'Resets {{when}}', {
                    when: (monthly ?? pools[0])?.resetDescription ?? ''
                  })}
                </p>
              ) : null}
              {staleUsageError ? (
                <p className="text-xs text-destructive">
                  {t(
                    'auto.components.settings.CursorAccountsSection.staleUsage',
                    'Last known usage — the latest refresh failed: {{reason}}',
                    { reason: staleUsageError }
                  )}
                </p>
              ) : null}
            </div>
          </SearchableSetting>
        ) : unavailableReason ? (
          <SearchableSetting
            title={t('auto.components.settings.CursorAccountsSection.usageLabel', 'Usage')}
            description={t(
              'auto.components.settings.CursorAccountsSection.noAllowance',
              'Cursor reported no usage allowance for this account.'
            )}
            keywords={SEARCH_KEYWORDS}
            className="py-3"
          >
            <p className="text-xs text-muted-foreground">{unavailableReason}</p>
          </SearchableSetting>
        ) : null}
      </SettingsGroup>
    </div>
  )
}
