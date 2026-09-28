import { useCallback, useState } from 'react'
import { ExternalLink, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '../../store'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { SearchableSetting } from './SearchableSetting'

const KIRO_CLI_DOCS_URL = 'https://kiro.dev/docs/cli/'

// Kiro is CLI/SSO-authenticated: Orca reads the monthly plan usage by running
// `kiro-cli /usage`. There is no credential to manage here — the section
// surfaces the current plan meter and a manual refresh, mirroring Grok.
export function KiroAccountsSection(): React.JSX.Element {
  const refreshKiroUsage = useAppStore((s) => s.refreshKiroUsage)
  const kiro = useAppStore((s) => s.rateLimits.kiro)
  const [refreshing, setRefreshing] = useState(false)

  const handleRefreshUsage = useCallback(async (): Promise<void> => {
    setRefreshing(true)
    try {
      await refreshKiroUsage(true)
    } finally {
      setRefreshing(false)
    }
  }, [refreshKiroUsage])

  const monthly = kiro?.monthly ?? null
  const signedIn = kiro?.status === 'ok' && monthly !== null
  const unavailableReason = kiro && kiro.status !== 'ok' && !monthly ? (kiro.error ?? null) : null

  return (
    <section id="accounts-kiro" className="space-y-4 scroll-mt-6">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <AgentIcon agent="kiro" size={16} />
            {translate('auto.components.settings.KiroAccountsSection.title', 'Kiro')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.KiroAccountsSection.description',
              'Shows monthly plan usage from your Kiro CLI sign-in (kiro-cli /usage).'
            )}
          </p>
        </div>
        <a
          href={KIRO_CLI_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {translate('auto.components.settings.KiroAccountsSection.docs', 'Kiro CLI docs')}
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
          {signedIn ? (
            <>
              <p className="truncate text-xs font-medium">
                {kiro?.planType ??
                  translate('auto.components.settings.KiroAccountsSection.signedIn', 'Signed in')}
              </p>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.KiroAccountsSection.reads',
                  'Signed in. Orca reads your plan usage by running kiro-cli /usage.'
                )}
              </p>
            </>
          ) : (
            <>
              <p className="text-xs font-medium">
                {translate(
                  'auto.components.settings.KiroAccountsSection.notSignedIn',
                  'Not signed in to Kiro CLI'
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.KiroAccountsSection.signInHint',
                  'In a terminal, run kiro-cli login, then click Refresh usage here.'
                )}
              </p>
            </>
          )}
          {unavailableReason ? (
            <p className="text-xs text-destructive">{unavailableReason}</p>
          ) : null}
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
          {translate('auto.components.settings.KiroAccountsSection.refresh', 'Refresh usage')}
        </Button>
      </div>

      {monthly ? (
        <SearchableSetting
          title={translate('auto.components.settings.KiroAccountsSection.monthly', 'Monthly usage')}
          description={translate(
            'auto.components.settings.KiroAccountsSection.monthlyDesc',
            'Same monthly plan % as the kiro-cli /usage screen.'
          )}
          keywords={['kiro', 'usage', 'credits', 'plan', 'monthly']}
        >
          <div className="flex items-center gap-2 text-xs">
            <Badge variant="secondary" className="tabular-nums">
              {Math.round(monthly.usedPercent)}%
            </Badge>
            {kiro?.kiroCredits ? (
              <span className="text-muted-foreground tabular-nums">
                {translate(
                  'auto.components.settings.KiroAccountsSection.credits',
                  '{{value0}} / {{value1}} credits',
                  {
                    value0: String(Number(kiro.kiroCredits.used.toFixed(2))),
                    value1: String(Number(kiro.kiroCredits.limit.toFixed(2)))
                  }
                )}
              </span>
            ) : null}
            {monthly.resetDescription ? (
              <span className="text-muted-foreground">
                {translate(
                  'auto.components.settings.KiroAccountsSection.resets',
                  'Resets {{when}}',
                  {
                    when: monthly.resetDescription
                  }
                )}
              </span>
            ) : null}
          </div>
        </SearchableSetting>
      ) : null}
    </section>
  )
}
