import React, { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '../../store'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import type { AntigravityAccountStatus } from '../../../../shared/rate-limit-types'
import { SearchableSetting } from './SearchableSetting'
import type { AccountsPaneSectionModel } from './accounts-pane-types'

export function AntigravityAccountsSection({
  model
}: {
  model: AccountsPaneSectionModel
}): React.JSX.Element {
  const { localAccountRuntimeSentenceLabel, recordFeatureInteraction, settings, updateSettings } =
    model
  const antigravityUsage = useAppStore((s) => s.rateLimits.antigravity)
  const refreshRateLimits = useAppStore((s) => s.refreshRateLimits)
  const [status, setStatus] = useState<AntigravityAccountStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const loadStatus = useCallback(async (): Promise<void> => {
    try {
      if (window.api.antigravityAccounts?.getStatus) {
        const next = await window.api.antigravityAccounts.getStatus()
        setStatus(next)
      } else {
        setStatus({
          signedIn: false,
          email: null,
          tokenFresh: false,
          error: null
        })
      }
    } catch (error) {
      console.error('Failed to load Antigravity account status:', error)
      setStatus({
        signedIn: false,
        email: null,
        tokenFresh: false,
        error: error instanceof Error ? error.message : 'Unable to read Antigravity sign-in'
      })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus, antigravityUsage?.updatedAt])

  const handleRefreshUsage = async (): Promise<void> => {
    setRefreshing(true)
    try {
      recordFeatureInteraction('usage-tracking')
      await refreshRateLimits()
      await loadStatus()
    } finally {
      setRefreshing(false)
    }
  }

  const signedIn = status?.signedIn === true
  const tokenFresh = status?.tokenFresh === true
  const buckets = antigravityUsage?.buckets ?? []
  const hasBuckets = buckets.length > 0
  const sessionWindow = antigravityUsage?.session ?? null

  return (
    <section key="antigravity" id="accounts-antigravity" className="space-y-4 scroll-mt-6">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <AgentIcon agent="antigravity" size={16} />
          {translate(
            'auto.components.settings.AntigravityAccountsSection.title',
            'Antigravity CLI'
          )}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.AntigravityAccountsSection.description',
            'Configure Antigravity CLI provider settings and monitor quota.'
          )}
        </p>
      </div>

      <div
        className={cn(
          'flex items-start gap-3 rounded-lg border bg-muted/20 p-3',
          signedIn && tokenFresh ? 'border-border/60' : 'border-border/40'
        )}
      >
        {signedIn && tokenFresh ? (
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-foreground" />
        ) : (
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1 space-y-1">
          {loading ? (
            <p className="text-xs text-muted-foreground">
              {translate('auto.components.settings.AntigravityAccountsSection.loading', 'Loading…')}
            </p>
          ) : signedIn ? (
            <>
              <p className="truncate text-xs font-medium">
                {status?.email ??
                  translate(
                    'auto.components.settings.AntigravityAccountsSection.signedIn',
                    'Signed in'
                  )}
              </p>
              <p className="text-xs text-muted-foreground">
                {tokenFresh
                  ? translate(
                      'auto.components.settings.AntigravityAccountsSection.signedInDetail',
                      'Signed in. Orca reads the Antigravity CLI credentials stored on disk.'
                    )
                  : translate(
                      'auto.components.settings.AntigravityAccountsSection.staleTokenDetail',
                      'Credentials may need refresh — run agy in your terminal if quota updates fail.'
                    )}
              </p>
            </>
          ) : (
            <>
              <p className="text-xs font-medium">
                {translate(
                  'auto.components.settings.AntigravityAccountsSection.notSignedIn',
                  'Not signed in to Antigravity CLI'
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.AntigravityAccountsSection.signInPrompt',
                  'In a terminal, run agy login, then click Refresh quota here.'
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
          {translate(
            'auto.components.settings.AntigravityAccountsSection.refreshQuota',
            'Refresh quota'
          )}
        </Button>
      </div>

      <SearchableSetting
        title={translate(
          'auto.components.settings.AntigravityAccountsSection.enableOAuthTitle',
          'Use Antigravity CLI credentials'
        )}
        description={translate(
          'auto.components.settings.AntigravityAccountsSection.enableOAuthDescription',
          'Extracts OAuth credentials from your local Antigravity CLI installation to query model rate limits and quota.'
        )}
        keywords={[
          'antigravity',
          'agy',
          'cli',
          'oauth',
          'credentials',
          'rate limit',
          'quota',
          'status bar'
        ]}
        className="flex items-center justify-between gap-4 py-2"
      >
        <div className="space-y-0.5">
          <Label>
            {translate(
              'auto.components.settings.AntigravityAccountsSection.enableOAuthLabel',
              'Enable Antigravity CLI quota tracking'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.AntigravityAccountsSection.enableOAuthSubtext',
              'Extracts OAuth credentials from your local Antigravity CLI installation to query model rate limits and quota for {{value0}}.',
              { value0: localAccountRuntimeSentenceLabel }
            )}
          </p>
        </div>
        <Switch
          aria-label={translate(
            'auto.components.settings.AntigravityAccountsSection.enableOAuthLabel',
            'Enable Antigravity CLI quota tracking'
          )}
          checked={settings.antigravityCliOAuthEnabled}
          onCheckedChange={(checked) => {
            recordFeatureInteraction('usage-tracking')
            updateSettings({
              antigravityCliOAuthEnabled: checked
            })
          }}
        />
      </SearchableSetting>

      {settings.antigravityCliOAuthEnabled && hasBuckets ? (
        <div className="space-y-2 pt-1">
          <h4 className="text-xs font-medium text-muted-foreground">
            {translate(
              'auto.components.settings.AntigravityAccountsSection.modelQuota',
              'Model Quota'
            )}
          </h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {buckets.map((bucket) => (
              <div
                key={bucket.name}
                className="flex items-center justify-between rounded-md border border-border/50 bg-muted/10 px-3 py-2 text-xs"
              >
                <div className="space-y-0.5">
                  <span className="font-medium text-foreground">{bucket.name}</span>
                  {bucket.resetDescription ? (
                    <p className="text-[11px] text-muted-foreground">
                      {translate(
                        'auto.components.settings.AntigravityAccountsSection.resetsAt',
                        'Resets {{when}}',
                        { when: bucket.resetDescription }
                      )}
                    </p>
                  ) : null}
                </div>
                <Badge variant="secondary" className="tabular-nums">
                  {Math.round(bucket.usedPercent)}% used
                </Badge>
              </div>
            ))}
          </div>
        </div>
      ) : settings.antigravityCliOAuthEnabled && sessionWindow ? (
        <div className="space-y-2 pt-1">
          <h4 className="text-xs font-medium text-muted-foreground">
            {translate(
              'auto.components.settings.AntigravityAccountsSection.sessionQuota',
              'Session Quota'
            )}
          </h4>
          <div className="flex items-center justify-between rounded-md border border-border/50 bg-muted/10 px-3 py-2 text-xs">
            <div className="space-y-0.5">
              <span className="font-medium text-foreground">
                {translate(
                  'auto.components.settings.AntigravityAccountsSection.sessionWindow',
                  '5-Hour Window'
                )}
              </span>
              {sessionWindow.resetDescription ? (
                <p className="text-[11px] text-muted-foreground">
                  {translate(
                    'auto.components.settings.AntigravityAccountsSection.resetsAt',
                    'Resets {{when}}',
                    { when: sessionWindow.resetDescription }
                  )}
                </p>
              ) : null}
            </div>
            <Badge variant="secondary" className="tabular-nums">
              {Math.round(sessionWindow.usedPercent)}% used
            </Badge>
          </div>
        </div>
      ) : null}
    </section>
  )
}
