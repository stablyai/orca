import { useState } from 'react'
import { Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '../../store'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { SearchableSetting } from './SearchableSetting'

// Why no sign-in button: Orca only reads an existing Copilot login and never
// writes, refreshes, or revokes the user's GitHub credentials.
export function CopilotAccountsSection(): React.JSX.Element {
  const refreshRateLimits = useAppStore((s) => s.refreshRateLimits)
  const usage = useAppStore((s) => s.rateLimits.copilot)
  const [refreshing, setRefreshing] = useState(false)

  const handleRefresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await refreshRateLimits()
    } finally {
      setRefreshing(false)
    }
  }

  const loading = usage == null || (usage.status === 'fetching' && !usage.monthly)
  const signedIn = usage != null && usage.status !== 'unavailable'
  const healthy = usage?.status === 'ok'
  const premium = usage?.monthly ?? null

  return (
    <section id="accounts-copilot" className="space-y-4 scroll-mt-6">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <AgentIcon agent="copilot" size={16} />
          {translate('auto.components.settings.CopilotAccountsSection.title', 'GitHub Copilot')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.CopilotAccountsSection.description',
            'Uses your existing Copilot login (Copilot CLI keychain item, or ~/.config/github-copilot from copilot.vim, Zed, or JetBrains) to show monthly premium request usage.'
          )}
        </p>
      </div>

      <div
        className={cn(
          'flex items-start gap-3 rounded-lg border bg-muted/20 p-3',
          healthy ? 'border-border/60' : 'border-border/40'
        )}
      >
        <ShieldCheck
          className={cn(
            'mt-0.5 size-4 shrink-0',
            healthy ? 'text-foreground' : 'text-muted-foreground'
          )}
        />
        <div className="min-w-0 flex-1 space-y-1">
          {loading ? (
            <p className="text-xs text-muted-foreground">
              {translate('auto.components.settings.CopilotAccountsSection.loading', 'Loading…')}
            </p>
          ) : signedIn ? (
            <>
              <p className="text-xs font-medium">
                {usage?.planType
                  ? translate(
                      'auto.components.settings.CopilotAccountsSection.plan',
                      'Copilot {{plan}}',
                      { plan: usage.planType }
                    )
                  : translate(
                      'auto.components.settings.CopilotAccountsSection.signedIn',
                      'Signed in'
                    )}
              </p>
              {usage?.error ? <p className="text-xs text-destructive">{usage.error}</p> : null}
            </>
          ) : (
            <>
              <p className="text-xs font-medium">
                {translate(
                  'auto.components.settings.CopilotAccountsSection.notSignedIn',
                  'No Copilot login found'
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.CopilotAccountsSection.signInHint',
                  'Run copilot and use /login, then click Refresh usage here.'
                )}
              </p>
            </>
          )}
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
          {translate('auto.components.settings.CopilotAccountsSection.refresh', 'Refresh usage')}
        </Button>
      </div>

      {premium ? (
        <SearchableSetting
          title={translate(
            'auto.components.settings.CopilotAccountsSection.premiumTitle',
            'Premium requests'
          )}
          description={translate(
            'auto.components.settings.CopilotAccountsSection.premiumDescription',
            'Monthly premium request allowance, as shown in VS Code.'
          )}
          keywords={['copilot', 'github', 'usage', 'premium', 'credits']}
        >
          <div className="flex items-center gap-2 text-xs">
            <Badge variant="secondary" className="tabular-nums">
              {Math.round(premium.usedPercent)}%
            </Badge>
            {premium.resetDescription ? (
              <span className="truncate text-muted-foreground">{premium.resetDescription}</span>
            ) : null}
            {premium.resetsAt ? (
              <span className="text-muted-foreground">
                {translate(
                  'auto.components.settings.CopilotAccountsSection.resets',
                  'Resets {{when}}',
                  { when: new Date(premium.resetsAt).toLocaleDateString() }
                )}
              </span>
            ) : null}
          </div>
        </SearchableSetting>
      ) : null}
    </section>
  )
}
