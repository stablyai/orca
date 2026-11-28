import { useEffect, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '../../../../store'
import { Label } from '../../../ui/label'
import { Switch } from '../../../ui/switch'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import type { AntigravityStatusLineStatus } from '../../../../../../shared/agent-usage/rate-limits/antigravity-statusline-status'

export function AntigravityStatusLineUsageSetting({
  windows
}: {
  windows: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const recordFeatureInteraction = useAppStore((state) => state.recordFeatureInteraction)
  const [status, setStatus] = useState<AntigravityStatusLineStatus | null>(null)
  const enabled = settings?.antigravityStatusLineUsageEnabled === true
  // Orca's status-hook gate also blocks this feed, so the row says so instead of staying empty.
  const unsupported = windows || status?.state === 'unsupported'
  const statusHooksOff = settings?.agentStatusHooksEnabled === false
  // Main installs or removes the hook when the setting flips; reading waits for that to finish.
  useEffect(() => {
    let cancelled = false
    void window.api.rateLimits.readAntigravityStatusLineStatus?.().then(
      (next) => !cancelled && setStatus(next),
      () => !cancelled && setStatus({ state: 'error', configPath: '', detail: null })
    )
    return () => {
      cancelled = true
    }
  }, [enabled])
  if (!settings) {
    return null
  }
  const title = t('accounts.antigravity.statusLineUsage.title', "Show usage from agy's status line")
  const description = t(
    'accounts.antigravity.statusLineUsage.description',
    'Orca reads the quota agy already shows to its status line in Orca terminals. Orca never runs agy for this. Your own status line keeps working.'
  )
  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={['antigravity', 'agy', 'usage', 'quota', 'status line', 'status bar']}
      className="py-3"
    >
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="antigravity-statusline-usage" className="min-w-0">
          <span className="truncate">{title}</span>
        </Label>
        <Switch
          id="antigravity-statusline-usage"
          aria-describedby="antigravity-statusline-usage-description"
          checked={enabled && !unsupported}
          disabled={unsupported}
          onCheckedChange={(checked) => {
            recordFeatureInteraction('usage-tracking')
            void updateSettings({ antigravityStatusLineUsageEnabled: checked })
          }}
        />
      </div>
      <p
        id="antigravity-statusline-usage-description"
        className="mt-1 text-xs text-muted-foreground"
      >
        {windows
          ? t(
              'accounts.antigravity.statusLineUsage.windows',
              "Not available on Windows: agy's status line runs through a POSIX shell."
            )
          : status?.state === 'unsupported'
            ? t(
                'accounts.antigravity.statusLineUsage.wsl',
                'Not available when Orca runs inside WSL: agy runs on another host.'
              )
            : description}
      </p>
      {enabled && statusHooksOff ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {t(
            'accounts.antigravity.statusLineUsage.needsStatusHooks',
            'Usage needs Agent Status Hooks, which are off. Turn them on in Settings → Agents.'
          )}
        </p>
      ) : null}
      {status?.state === 'error' ? (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {status.detail ??
            t(
              'accounts.antigravity.statusLineUsage.error',
              "Orca couldn't update agy's status line."
            )}
        </p>
      ) : null}
    </SearchableSetting>
  )
}
