import { useState } from 'react'
import { ExternalLink, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '../../store'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { SearchableSetting } from './SearchableSetting'

const COPILOT_CLI_DOCS_URL = 'https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli'

export function CopilotAccountsSection(): React.JSX.Element {
  const refreshRateLimits = useAppStore((s) => s.refreshRateLimits)
  const copilotUsage = useAppStore((s) => s.rateLimits.copilot)
  const [refreshing, setRefreshing] = useState(false)

  const handleRefreshUsage = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await refreshRateLimits()
    } finally {
      setRefreshing(false)
    }
  }

  // Why: the fetcher itself reads Copilot CLI credentials on every cycle, so
  // its own snapshot status is the durable sign-in signal — no separate IPC.
  const loading = copilotUsage === null
  const signedIn = copilotUsage !== null && copilotUsage.status !== 'unavailable'

  return (
    <section id="accounts-copilot" className="space-y-4 scroll-mt-6">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <AgentIcon agent="copilot" size={16} />
            {translate(
              'auto.components.settings.CopilotAccountsSection.a1b2c3d4e5',
              'GitHub Copilot'
            )}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.CopilotAccountsSection.f6e5d4c3b2',
              'Shows premium interactions usage from your Copilot CLI sign-in.'
            )}
          </p>
        </div>
        <a
          href={COPILOT_CLI_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {translate(
            'auto.components.settings.CopilotAccountsSection.0d8e77bc40',
            'Copilot CLI docs'
          )}
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
              {translate('auto.components.settings.CopilotAccountsSection.ad47a33f72', 'Loading…')}
            </p>
          ) : signedIn ? (
            <>
              <p className="truncate text-xs font-medium">
                {translate(
                  'auto.components.settings.CopilotAccountsSection.b2c3d4e5f6',
                  'Signed in'
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.CopilotAccountsSection.c3d4e5f6a7',
                  'Signed in. Orca only reads your Copilot CLI credentials — run copilot again if usage fails.'
                )}
              </p>
            </>
          ) : (
            <>
              <p className="text-xs font-medium">
                {translate(
                  'auto.components.settings.CopilotAccountsSection.e5f6a7b8c9',
                  'Not signed in to Copilot CLI'
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.CopilotAccountsSection.f6a7b8c9d0',
                  'In a terminal, run copilot and sign in, then click Refresh usage here.'
                )}
              </p>
            </>
          )}
          {copilotUsage?.error ? (
            <p className="text-xs text-destructive">{copilotUsage.error}</p>
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
          {translate('auto.components.settings.CopilotAccountsSection.3325d996cb', 'Refresh usage')}
        </Button>
      </div>

      {copilotUsage?.monthly ? (
        <SearchableSetting
          title={translate(
            'auto.components.settings.CopilotAccountsSection.a8f3e2c1b4',
            'Premium interactions'
          )}
          description={translate(
            'auto.components.settings.CopilotAccountsSection.b7e2d9f0a3',
            'Same monthly premium interactions quota shown in your Copilot billing settings.'
          )}
          keywords={['copilot', 'github', 'usage', 'premium', 'interactions']}
        >
          <div className="flex items-center gap-2 text-xs">
            <Badge variant="secondary" className="tabular-nums">
              {Math.round(copilotUsage.monthly.usedPercent)}%
            </Badge>
            {copilotUsage.monthly.resetDescription ? (
              <span className="text-muted-foreground">
                {translate(
                  'auto.components.settings.CopilotAccountsSection.c6d1a8f4e2',
                  'Resets {{when}}',
                  { when: copilotUsage.monthly.resetDescription }
                )}
              </span>
            ) : null}
          </div>
        </SearchableSetting>
      ) : null}
    </section>
  )
}
