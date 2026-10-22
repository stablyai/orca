import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import type { MuseAccountStatus } from '../../../../shared/rate-limit-types'

// Why: the sign-in itself is CLI-owned (`muse login` runs a browser device flow the app
// cannot drive), so this section only reports the CLI session stored on disk, like Grok's.
const MUSE_CLI_DOCS_URL = 'https://dev.meta.ai/docs/muse-code'

export function MuseAccountsSection(): React.JSX.Element {
  const [status, setStatus] = useState<MuseAccountStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const loadStatus = useCallback(async (): Promise<void> => {
    try {
      const next = await window.api.museAccounts.getStatus()
      setStatus(next)
    } catch (error) {
      console.error('Failed to load Muse account status:', error)
      setStatus({
        signedIn: false,
        email: null,
        fullName: null,
        subscriptionActive: null,
        obtainedVia: null,
        error: error instanceof Error ? error.message : 'Unable to read Muse sign-in'
      })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  const handleRefresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await loadStatus()
    } finally {
      setRefreshing(false)
    }
  }

  const signedIn = status?.signedIn === true

  return (
    <section id="accounts-muse" className="space-y-4 scroll-mt-6">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <AgentIcon agent="muse" size={16} />
            {translate('auto.components.settings.MuseAccountsSection.a1b2c3d4e5', 'Muse (Meta)')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.MuseAccountsSection.f6e5d4c3b2',
              'Shows your Muse CLI sign-in (session file ~/.config/muse/auth.json).'
            )}
          </p>
        </div>
        <a
          href={MUSE_CLI_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {translate('auto.components.settings.MuseAccountsSection.0d8e77bc40', 'Muse docs')}
          <ExternalLink className="size-3" />
        </a>
      </div>

      <div
        className={cn(
          'flex items-start gap-3 rounded-lg border bg-muted/20 p-3',
          signedIn ? 'border-border/60' : 'border-border/40'
        )}
      >
        <ShieldCheck
          className={cn(
            'mt-0.5 size-4 shrink-0',
            signedIn ? 'text-foreground' : 'text-muted-foreground'
          )}
        />
        <div className="min-w-0 flex-1 space-y-1">
          {loading ? (
            <p className="text-xs text-muted-foreground">
              {translate('auto.components.settings.MuseAccountsSection.ad47a33f72', 'Loading…')}
            </p>
          ) : signedIn ? (
            <>
              <p className="truncate text-xs font-medium">
                {status?.email ??
                  status?.fullName ??
                  translate('auto.components.settings.MuseAccountsSection.b2c3d4e5f6', 'Signed in')}
              </p>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.MuseAccountsSection.b36fa2c908',
                  'Signed in. Orca reads the Muse CLI session stored on disk.'
                )}
              </p>
            </>
          ) : (
            <>
              <p className="text-xs font-medium">
                {translate(
                  'auto.components.settings.MuseAccountsSection.e5f6a7b8c9',
                  'Not signed in to Muse CLI'
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.MuseAccountsSection.f6a7b8c9d0',
                  'In a terminal, run muse login and approve the code in your browser, then click Refresh status here.'
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
          onClick={() => void handleRefresh()}
          className="shrink-0 gap-1"
        >
          {refreshing ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <RefreshCw className="size-3" />
          )}
          {translate('auto.components.settings.MuseAccountsSection.3325d996cb', 'Refresh status')}
        </Button>
      </div>
    </section>
  )
}
