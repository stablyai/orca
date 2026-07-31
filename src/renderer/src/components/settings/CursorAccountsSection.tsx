import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '../../store'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import type { CursorAccountStatus } from '../../../../shared/rate-limit-types'
import { SearchableSetting } from './SearchableSetting'

const CURSOR_DOCS_URL = 'https://cursor.com/docs'

export function CursorAccountsSection(): React.JSX.Element {
  const refreshCursorRateLimits = useAppStore((s) => s.refreshCursorRateLimits)
  const cursorUsage = useAppStore((s) => s.rateLimits.cursor)
  const [status, setStatus] = useState<CursorAccountStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const loadStatus = useCallback(async (): Promise<void> => {
    try {
      const next = await window.api.cursorAccounts.getStatus()
      setStatus(next)
    } catch (error) {
      console.error('Failed to load Cursor account status:', error)
      setStatus({
        signedIn: false,
        email: null,
        userId: null,
        tokenFresh: false,
        error: error instanceof Error ? error.message : 'Unable to read Cursor sign-in'
      })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus, cursorUsage?.updatedAt])

  const handleRefreshUsage = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await refreshCursorRateLimits()
      await loadStatus()
    } finally {
      setRefreshing(false)
    }
  }

  const signedIn = status?.signedIn === true
  const tokenFresh = status?.tokenFresh === true
  const usageWindow = cursorUsage?.monthly ?? null
  const autoBucket = cursorUsage?.buckets?.find((b) => b.name === 'Auto')
  const apiBucket = cursorUsage?.buckets?.find((b) => b.name === 'API')

  return (
    <section id="accounts-cursor" className="space-y-4 scroll-mt-6">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <AgentIcon agent="cursor" size={16} />
            {translate('auto.components.settings.CursorAccountsSection.a1b2c3d4e5', 'Cursor')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.CursorAccountsSection.f6e5d4c3b2',
              'Shows plan usage from your Cursor IDE sign-in (globalStorage state database).'
            )}
          </p>
        </div>
        <a
          href={CURSOR_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {translate('auto.components.settings.CursorAccountsSection.0d8e77bc40', 'Cursor docs')}
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
              {translate('auto.components.settings.CursorAccountsSection.ad47a33f72', 'Loading…')}
            </p>
          ) : signedIn ? (
            <>
              <p className="truncate text-xs font-medium">
                {status?.email ??
                  translate(
                    'auto.components.settings.CursorAccountsSection.b2c3d4e5f6',
                    'Signed in'
                  )}
              </p>
              <p className="text-xs text-muted-foreground">
                {tokenFresh
                  ? translate(
                      'auto.components.settings.CursorAccountsSection.b36fa2c908',
                      'Signed in. Orca reads the Cursor IDE session stored on disk.'
                    )
                  : translate(
                      'auto.components.settings.CursorAccountsSection.f08c41de73',
                      'Session expired — sign in to Cursor on the computer running Orca, then click Refresh usage.'
                    )}
              </p>
            </>
          ) : (
            <>
              <p className="text-xs font-medium">
                {translate(
                  'auto.components.settings.CursorAccountsSection.e5f6a7b8c9',
                  'Not signed in to Cursor'
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.CursorAccountsSection.f6a7b8c9d0',
                  'Open Cursor and sign in, then click Refresh usage here.'
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
          {translate('auto.components.settings.CursorAccountsSection.3325d996cb', 'Refresh usage')}
        </Button>
      </div>

      {usageWindow || autoBucket || apiBucket ? (
        <SearchableSetting
          title={translate(
            'auto.components.settings.CursorAccountsSection.a8f3e2c1b4',
            'Plan usage'
          )}
          description={translate(
            'auto.components.settings.CursorAccountsSection.b7e2d9f0a3',
            'Same plan / Auto / API % as the Cursor dashboard.'
          )}
          keywords={['cursor', 'usage', 'subscription', 'plan', 'auto', 'api']}
        >
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {usageWindow ? (
              <Badge variant="secondary" className="tabular-nums">
                {translate(
                  'auto.components.settings.CursorAccountsSection.d5e0b7c3a1',
                  'Plan {{pct}}%',
                  { pct: String(Math.round(usageWindow.usedPercent)) }
                )}
              </Badge>
            ) : null}
            {autoBucket ? (
              <Badge variant="secondary" className="tabular-nums">
                {translate(
                  'auto.components.settings.CursorAccountsSection.e4f1c8d2b0',
                  'Auto {{pct}}%',
                  { pct: String(Math.round(autoBucket.usedPercent)) }
                )}
              </Badge>
            ) : null}
            {apiBucket ? (
              <Badge variant="secondary" className="tabular-nums">
                {translate(
                  'auto.components.settings.CursorAccountsSection.f3a2d9e1c7',
                  'API {{pct}}%',
                  { pct: String(Math.round(apiBucket.usedPercent)) }
                )}
              </Badge>
            ) : null}
            {usageWindow?.resetDescription ? (
              <span className="text-muted-foreground">
                {translate(
                  'auto.components.settings.CursorAccountsSection.c6d1a8f4e2',
                  'Resets {{when}}',
                  { when: usageWindow.resetDescription }
                )}
              </span>
            ) : null}
            {cursorUsage?.usageMetadata?.authProvenance ? (
              <span className="truncate text-muted-foreground">
                {cursorUsage.usageMetadata.authProvenance}
              </span>
            ) : null}
          </div>
        </SearchableSetting>
      ) : null}
    </section>
  )
}
