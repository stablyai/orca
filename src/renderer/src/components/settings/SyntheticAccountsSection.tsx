import { useState } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import { useDelayedStatus } from '@/hooks/use-delayed-status'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { SyntheticIcon } from '../status-bar/SyntheticIcon'
import { Progress } from '../ui/progress'
import { DebouncedSettingsTextInput } from './DebouncedSettingsTextInput'
import { SearchableSetting } from './SearchableSetting'
import type { AccountsPaneProps } from './accounts-pane-types'

const quotaDateTimeFormat = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true
})

export function SyntheticAccountsSection({
  settings,
  updateSettings
}: AccountsPaneProps): React.JSX.Element {
  const usage = useAppStore((s) => s.rateLimits.synthetic)
  const refreshRateLimits = useAppStore((s) => s.refreshRateLimits)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState(false)
  const showSpinner = useDelayedStatus('synthetic-usage-refresh', refreshing ? true : null, 1000)
  const quota = usage?.requestQuota
  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    setRefreshError(false)
    try {
      await refreshRateLimits({ throwOnError: true })
    } catch {
      setRefreshError(true)
    } finally {
      setRefreshing(false)
    }
  }
  return (
    <section id="accounts-synthetic" className="space-y-4 scroll-mt-6">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <SyntheticIcon />
            {translate('settings.synthetic.sectionTitle', 'Synthetic')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'settings.synthetic.description',
              'Read Synthetic subscription usage for the Orca runtime on this device. This does not change agent credentials in local, WSL, or SSH workspaces.'
            )}
          </p>
        </div>
        <a
          href="https://dev.synthetic.new/docs/synthetic/quotas"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {translate('settings.synthetic.docs', 'Quota docs')}
          <ExternalLink className="size-3" />
        </a>
      </div>
      <SearchableSetting
        title={translate('settings.synthetic.key', 'Synthetic API key')}
        keywords={['synthetic', 'api', 'key', 'usage', 'quota']}
        className="space-y-2"
      >
        <Label htmlFor="synthetic-api-key">
          {translate('settings.synthetic.key', 'Synthetic API key')}
        </Label>
        <div className="flex gap-2">
          <DebouncedSettingsTextInput
            id="synthetic-api-key"
            type="password"
            value={settings.syntheticApiKey ?? ''}
            commit={(syntheticApiKey) => updateSettings({ syntheticApiKey })}
            spellCheck={false}
            className="flex-1"
          />
          {settings.syntheticApiKey && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => updateSettings({ syntheticApiKey: '' })}
            >
              {translate('settings.synthetic.clear', 'Clear')}
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {translate(
            'settings.synthetic.keyHelp',
            'Stored using Orca’s protected secret storage and sent only to api.synthetic.new. Leave blank to use SYNTHETIC_API_KEY from the Orca runtime’s environment.'
          )}
        </p>
      </SearchableSetting>
      {quota && (
        <div className="space-y-2">
          <Label>{translate('settings.synthetic.fiveHours', 'Five-hour request usage')}</Label>
          <p className="text-xs tabular-nums">
            {translate('settings.synthetic.requests', '{{requests}} / {{limit}} requests used', {
              requests: quota.requests,
              limit: quota.limit
            })}
          </p>
          <Progress
            aria-label={translate('settings.synthetic.progress', 'Synthetic subscription usage')}
            value={usage?.session?.usedPercent ?? 0}
          />
          {usage?.session?.rechargesAt && (
            <p className="text-xs text-muted-foreground">
              {translate('settings.synthetic.rechargeDate', 'Full recharge {{date}}', {
                date: quotaDateTimeFormat.format(new Date(usage?.session.rechargesAt))
              })}
            </p>
          )}
          {usage?.session?.refillsAt && (
            <p className="text-xs text-muted-foreground">
              {translate('settings.synthetic.refill', 'Next refill {{date}}', {
                date: quotaDateTimeFormat.format(new Date(usage.session.refillsAt))
              })}
            </p>
          )}
          {quota.renewsAt && (
            <p className="text-xs text-muted-foreground">
              {translate('settings.synthetic.renews', 'Renews {{date}}', {
                date: quotaDateTimeFormat.format(new Date(quota.renewsAt))
              })}
            </p>
          )}
        </div>
      )}
      {usage?.weekly && (
        <div className="space-y-2">
          <Label>{translate('settings.synthetic.weekly', 'Weekly credit usage')}</Label>
          <p className="text-xs tabular-nums">
            {translate('settings.synthetic.percent', '{{percent}}% used', {
              percent: Math.round(usage.weekly.usedPercent * 100) / 100
            })}
          </p>
          <Progress
            aria-label={translate('settings.synthetic.weekly', 'Weekly credit usage')}
            value={usage.weekly.usedPercent}
          />
          {usage.weekly?.rechargesAt && (
            <p className="text-xs text-muted-foreground">
              {translate('settings.synthetic.rechargeDate', 'Full recharge {{date}}', {
                date: quotaDateTimeFormat.format(new Date(usage.weekly.rechargesAt))
              })}
            </p>
          )}
          {usage.weekly.refillsAt && (
            <p className="text-xs text-muted-foreground">
              {translate('settings.synthetic.refill', 'Next refill {{date}}', {
                date: quotaDateTimeFormat.format(new Date(usage.weekly.refillsAt))
              })}
            </p>
          )}
        </div>
      )}
      {(usage?.session?.rechargesAt != null || usage?.weekly?.rechargesAt != null) && (
        <p className="text-xs text-muted-foreground">
          {translate('settings.synthetic.rechargeEstimate', 'Estimated if no more usage.')}
        </p>
      )}
      {usage?.error && (
        <p role="alert" className="text-xs text-muted-foreground">
          {usage.error}
        </p>
      )}
      {refreshError && (
        <p role="alert" className="text-xs text-destructive">
          {translate('settings.synthetic.refreshError', 'Could not refresh usage. Try again.')}
        </p>
      )}
      {!usage && (
        <p className="text-xs text-muted-foreground">
          {translate(
            'settings.synthetic.empty',
            'Add an API key, then refresh to read your subscription quota.'
          )}
        </p>
      )}
      <Button
        variant="outline"
        size="sm"
        className="w-40"
        disabled={refreshing || usage?.status === 'fetching'}
        onClick={() => void refresh()}
      >
        {showSpinner && <Loader2 className="size-4 animate-spin" />}
        {translate('settings.synthetic.refresh', 'Refresh usage')}
      </Button>
    </section>
  )
}
