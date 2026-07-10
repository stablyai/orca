import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '../../store'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import type { GrokAccountStatus } from '../../../../shared/rate-limit-types'
import { SearchableSetting } from './SearchableSetting'
const GROK_CLI_DOCS_URL = 'https://docs.x.ai/build/overview'

export function GrokAccountsSection(): React.JSX.Element {
  const refreshGrokRateLimits = useAppStore((s) => s.refreshGrokRateLimits)
  const grokUsage = useAppStore((s) => s.rateLimits.grok)
  const [status, setStatus] = useState<GrokAccountStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const loadStatus = useCallback(async (): Promise<void> => {
    try {
      const next = await window.api.grokAccounts.getStatus()
      setStatus(next)
    } catch (error) {
      console.error('Failed to load Grok account status:', error)
      setStatus({
        signedIn: false,
        email: null,
        teamId: null,
        tokenFresh: false,
        error: error instanceof Error ? error.message : 'Unable to read Grok sign-in'
      })
    } finally {
      setLoading(false)
    }
  }, [])

  // Why: after a background usage fetch, sign-in state may change — reload status then.
  useEffect(() => {
    void loadStatus()
  }, [loadStatus, grokUsage?.updatedAt])

  const handleRefreshUsage = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await refreshGrokRateLimits()
      await loadStatus()
    } finally {
      setRefreshing(false)
    }
  }

  const signedIn = status?.signedIn === true
  const tokenFresh = status?.tokenFresh === true

  return (
    <section id="accounts-grok" className="space-y-4 scroll-mt-6">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <AgentIcon agent="grok" size={16} />
            {translate('auto.components.settings.GrokAccountsSection.a1b2c3d4e5', 'Grok (xAI)')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.GrokAccountsSection.f6e5d4c3b2',
              'Shows weekly credit usage from your Grok CLI sign-in (session file ~/.grok/auth.json).'
            )}
          </p>
        </div>
        <a
          href={GROK_CLI_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {translate('auto.components.settings.GrokAccountsSection.0d8e77bc40', 'Grok CLI docs')}
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
              {translate('auto.components.settings.GrokAccountsSection.ad47a33f72', 'Loading…')}
            </p>
          ) : signedIn ? (
            <>
              <p className="truncate text-xs font-medium">
                {status?.email ??
                  translate('auto.components.settings.GrokAccountsSection.b2c3d4e5f6', 'Signed in')}
              </p>
              <p className="text-xs text-muted-foreground">
                {tokenFresh
                  ? translate(
                      'auto.components.settings.GrokAccountsSection.c3d4e5f6a7',
                      'Signed in. Orca only reads that file on disk — run grok login again if usage fails.'
                    )
                  : translate(
                      'auto.components.settings.GrokAccountsSection.d4e5f6a7b8',
                      'Session expired — run grok login in a terminal to refresh.'
                    )}
              </p>
            </>
          ) : (
            <>
              <p className="text-xs font-medium">
                {translate(
                  'auto.components.settings.GrokAccountsSection.e5f6a7b8c9',
                  'Not signed in to Grok CLI'
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.GrokAccountsSection.f6a7b8c9d0',
                  'In a terminal, run grok login, then click Refresh usage here.'
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
          {translate('auto.components.settings.GrokAccountsSection.3325d996cb', 'Refresh usage')}
        </Button>
      </div>

      {grokUsage?.weekly ? (
        <SearchableSetting
          title={translate(
            'auto.components.settings.GrokAccountsSection.a8f3e2c1b4',
            'Weekly credits'
          )}
          description={translate(
            'auto.components.settings.GrokAccountsSection.b7e2d9f0a3',
            'Same weekly credit % as the grok /usage screen in the terminal.'
          )}
          keywords={['grok', 'xai', 'usage', 'credits', 'oauth']}
        >
          <div className="flex items-center gap-2 text-xs">
            <Badge variant="secondary" className="tabular-nums">
              {Math.round(grokUsage.weekly.usedPercent)}%
            </Badge>
            {grokUsage.weekly.resetDescription ? (
              <span className="text-muted-foreground">
                {translate(
                  'auto.components.settings.GrokAccountsSection.c6d1a8f4e2',
                  'Resets {{when}}',
                  { when: grokUsage.weekly.resetDescription }
                )}
              </span>
            ) : null}
            {grokUsage.usageMetadata?.authProvenance ? (
              <span className="truncate text-muted-foreground">
                {grokUsage.usageMetadata.authProvenance}
              </span>
            ) : null}
          </div>
        </SearchableSetting>
      ) : null}
    </section>
  )
}
