import { useState } from 'react'
import { ExternalLink, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '../../store'
import { useNow } from '../../hooks/use-now'
import { formatCreditCount } from '../../../../shared/credit-count-format'
import { Button } from '../ui/button'
import { SearchableSetting } from './SearchableSetting'
import {
  collectProviderUsageWindows,
  ProviderUsageWindowView,
  type ProviderUsageWindowKind
} from './provider-usage-windows'

const COMMAND_CODE_USAGE_URL = 'https://commandcode.ai/usage'

const SEARCH_KEYWORDS = ['command code', 'command-code', 'commandcode', 'credits', 'usage', 'cmd']

// Why a function, not a module-level map: the labels must resolve on each render
// so switching the interface language updates them.
function commandCodeWindowLabel(kind: ProviderUsageWindowKind): string {
  if (kind === 'session') {
    return translate('auto.components.settings.CommandCodeAccountsSection.window.session', '5-hour')
  }
  if (kind === 'weekly') {
    return translate('auto.components.settings.CommandCodeAccountsSection.window.weekly', 'Weekly')
  }
  return translate('auto.components.settings.CommandCodeAccountsSection.window.monthly', 'Monthly')
}

function formatRenewalDate(resetsAt: number): string {
  return new Date(resetsAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function CommandCodeAccountsSection(): React.JSX.Element {
  const refreshRateLimits = useAppStore((s) => s.refreshRateLimits)
  const commandCodeUsage = useAppStore((s) => s.rateLimits.commandCode)
  const authConfigured = useAppStore((s) => s.rateLimits.commandCodeAuthConfigured)
  const [refreshing, setRefreshing] = useState(false)
  const now = useNow(60_000)

  const usage = commandCodeUsage ?? null
  const usageWindows = collectProviderUsageWindows(usage)
  const staleUsageError = usage?.status === 'error' ? (usage.error ?? null) : null
  const credits = usage?.extraUsage?.unit === 'credits' ? usage.extraUsage : null
  const renewalAt = usage?.monthly?.resetsAt ?? null

  const handleRefreshUsage = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await refreshRateLimits()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <section id="accounts-command-code" className="space-y-4 scroll-mt-6">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <AgentIcon agent="command-code" size={16} />
            {translate('auto.components.settings.CommandCodeAccountsSection.title', 'Command Code')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.CommandCodeAccountsSection.subtitle',
              'Shows credits, plan usage windows, and the renewal date from your Command Code CLI sign-in.'
            )}
          </p>
        </div>
        <a
          href={COMMAND_CODE_USAGE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {translate('auto.components.settings.CommandCodeAccountsSection.usagePage', 'Usage page')}
          <ExternalLink className="size-3" />
        </a>
      </div>

      <div
        className={cn(
          'flex items-start gap-3 rounded-lg border bg-muted/20 p-3',
          authConfigured ? 'border-border/60' : 'border-border/40'
        )}
      >
        <ShieldCheck
          className={cn(
            'mt-0.5 size-4 shrink-0',
            authConfigured ? 'text-foreground' : 'text-muted-foreground'
          )}
        />
        <div className="min-w-0 flex-1 space-y-1">
          {authConfigured ? (
            <>
              <p className="text-xs font-medium">
                {translate(
                  'auto.components.settings.CommandCodeAccountsSection.signedIn',
                  'Signed in'
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.CommandCodeAccountsSection.signedInHint',
                  'Orca reads the Command Code login the CLI stored on this machine (COMMAND_CODE_API_KEY, else ~/.commandcode/auth.json). Orca keeps the key in the main process and sends it to the Command Code API for usage requests.'
                )}
              </p>
            </>
          ) : (
            <>
              <p className="text-xs font-medium">
                {translate(
                  'auto.components.settings.CommandCodeAccountsSection.notSignedIn',
                  'Not signed in'
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.CommandCodeAccountsSection.notSignedInHint',
                  'In a terminal, run cmd login, then click Refresh usage here.'
                )}
              </p>
            </>
          )}
          {staleUsageError ? <p className="text-xs text-destructive">{staleUsageError}</p> : null}
        </div>
        <Button
          variant="outline"
          size="xs"
          // Why: refresh is the step the signed-out copy asks for after `cmd login`,
          // so it must stay available while no credential is known yet.
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
            'auto.components.settings.CommandCodeAccountsSection.refresh',
            'Refresh usage'
          )}
        </Button>
      </div>

      {usageWindows.length > 0 || credits ? (
        <SearchableSetting
          title={translate(
            'auto.components.settings.CommandCodeAccountsSection.usageTitle',
            'Credits and usage'
          )}
          description={translate(
            'auto.components.settings.CommandCodeAccountsSection.usageDescription',
            'Same figures as the /usage overlay in the Command Code CLI.'
          )}
          keywords={SEARCH_KEYWORDS}
        >
          <div className="space-y-1">
            {usageWindows.map((row) => (
              <ProviderUsageWindowView
                key={row.kind}
                row={row}
                now={now}
                labels={commandCodeWindowLabel}
              />
            ))}
            {credits ? (
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.CommandCodeAccountsSection.creditsLeft',
                  '{{value0}} credits available',
                  { value0: formatCreditCount(credits.balance) }
                )}
              </p>
            ) : null}
            {renewalAt ? (
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.CommandCodeAccountsSection.renews',
                  'Renews {{value0}}',
                  { value0: formatRenewalDate(renewalAt) }
                )}
              </p>
            ) : null}
            {usage?.planType ? (
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.CommandCodeAccountsSection.plan',
                  'Plan: {{value0}}',
                  { value0: usage.planType }
                )}
              </p>
            ) : null}
          </div>
        </SearchableSetting>
      ) : null}
    </section>
  )
}
