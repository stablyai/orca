import { useCallback, useEffect, useRef, useState } from 'react'
import { ExternalLink, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useAppStore } from '../../../../store/index'
import { Badge } from '../../../ui/badge'
import { Button } from '../../../ui/button'
import type { CopilotAccountStatus } from '../../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { COPILOT_AIC_BUCKET_NAME } from '../../../../../../shared/agent-usage/rate-limits/copilot-usage-buckets'
import { getDisplayedUsagePercentage } from '../../../../../../shared/agent-usage/display/usage-percentage-display'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { openAppHttpLinkFromAnchor } from '@/lib/browser/navigation/app-http-link-open'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import { ACCOUNTS_SECTION_IDS } from '../accounts-search'

const COPILOT_SETTINGS_URL = 'https://github.com/settings/copilot'
const SEARCH_KEYWORDS = ['copilot', 'usage', 'aic', 'credits', 'github', 'status bar']

export function CopilotAccountsSection(): React.JSX.Element {
  const t = useTranslate()
  const refreshRateLimits = useAppStore((s) => s.refreshRateLimits)
  const copilotUsage = useAppStore((s) => s.rateLimits.copilot)
  const [status, setStatus] = useState<CopilotAccountStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const latestLoad = useRef(0)

  const loadStatus = useCallback(async (): Promise<void> => {
    const generation = latestLoad.current + 1
    latestLoad.current = generation
    const apply = (next: CopilotAccountStatus): void => {
      if (latestLoad.current !== generation) {
        return
      }
      setStatus(next)
      setLoading(false)
    }
    try {
      apply(await window.api.copilotAccounts.getStatus())
    } catch (error) {
      console.error('Failed to load Copilot account status:', error)
      apply({
        signedIn: false,
        login: null,
        planType: null,
        error: error instanceof Error ? error.message : 'Unable to read Copilot sign-in'
      })
    }
  }, [])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus, copilotUsage?.updatedAt])

  const handleRefreshUsage = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await refreshRateLimits()
    } finally {
      setRefreshing(false)
    }
  }

  const signedIn = status?.signedIn === true
  const buckets = copilotUsage?.buckets ?? []
  const aic = buckets.find((bucket) => bucket.name === COPILOT_AIC_BUCKET_NAME) ?? null
  const detailBuckets = buckets.filter((bucket) => bucket.name !== COPILOT_AIC_BUCKET_NAME)

  return (
    <div id={ACCOUNTS_SECTION_IDS.copilot} className="scroll-mt-6">
      <SettingsGroup
        title={
          <span className="flex items-center gap-2">
            <AgentIcon agent="copilot" size={16} />
            {t('auto.components.settings.CopilotAccountsSection.title', 'Copilot')}
          </span>
        }
        description={t(
          'auto.components.settings.CopilotAccountsSection.subtitle',
          'Shows AI credits from the Copilot CLI sign-in on this computer. Orca only reads it and never changes that login.'
        )}
        action={
          <a
            href={COPILOT_SETTINGS_URL}
            target="_blank"
            onClick={openAppHttpLinkFromAnchor}
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {t('auto.components.settings.CopilotAccountsSection.dashboardLink', 'GitHub Copilot')}
            <ExternalLink className="size-3" />
          </a>
        }
      >
        <div className="flex items-start gap-3 py-3">
          <ShieldCheck
            className={cn(
              'mt-0.5 size-4 shrink-0',
              signedIn ? 'text-foreground' : 'text-muted-foreground'
            )}
          />
          <div className="min-w-0 flex-1 space-y-1">
            {loading ? (
              <p className="text-xs text-muted-foreground">
                {t('auto.components.settings.CopilotAccountsSection.loading', 'Loading…')}
              </p>
            ) : signedIn ? (
              <>
                <p className="truncate text-xs font-medium">
                  {status?.login ??
                    t('auto.components.settings.CopilotAccountsSection.signedIn', 'Signed in')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {status?.planType
                    ? t(
                        'auto.components.settings.CopilotAccountsSection.signedInPlan',
                        'Signed in with Copilot CLI ({{plan}}). The status bar shows this account’s AI credits.',
                        { plan: status.planType }
                      )
                    : t(
                        'auto.components.settings.CopilotAccountsSection.signedInGeneric',
                        'Signed in with Copilot CLI. The status bar shows this account’s AI credits.'
                      )}
                </p>
              </>
            ) : (
              <>
                <p className="text-xs font-medium">
                  {t(
                    'auto.components.settings.CopilotAccountsSection.signedOut',
                    'No Copilot CLI sign-in found on this computer'
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t(
                    'auto.components.settings.CopilotAccountsSection.signedOutHelp',
                    'Run copilot login in a terminal, then click Refresh usage.'
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
            {t('auto.components.settings.CopilotAccountsSection.refreshUsage', 'Refresh usage')}
          </Button>
        </div>

        {aic ? (
          <SearchableSetting
            title={t('auto.components.settings.CopilotAccountsSection.usageTitle', 'AI credits')}
            description={t(
              'auto.components.settings.CopilotAccountsSection.usageDescription',
              'The status bar shows how much of this AIC allowance is left. Chat and completions stay in the usage details.'
            )}
            keywords={SEARCH_KEYWORDS}
            className="py-3"
          >
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-xs">
                <Badge variant="secondary">
                  <span className="tabular-nums">
                    {getDisplayedUsagePercentage(aic.usedPercent, 'remaining')}%
                  </span>
                </Badge>
                <span className="text-muted-foreground">
                  {t('auto.components.settings.CopilotAccountsSection.aicRemaining', 'AIC left')}
                </span>
              </div>
              {detailBuckets.map((bucket) => (
                <div key={bucket.name} className="flex items-center gap-2 text-xs">
                  <Badge variant="secondary">
                    <span className="tabular-nums">
                      {getDisplayedUsagePercentage(bucket.usedPercent, 'remaining')}%
                    </span>
                  </Badge>
                  <span className="text-muted-foreground">{bucket.name}</span>
                </div>
              ))}
              {aic.resetDescription ? (
                <p className="text-xs text-muted-foreground">
                  {t('auto.components.settings.CopilotAccountsSection.resets', 'Resets {{when}}', {
                    when: aic.resetDescription
                  })}
                </p>
              ) : null}
            </div>
          </SearchableSetting>
        ) : null}
      </SettingsGroup>
    </div>
  )
}
