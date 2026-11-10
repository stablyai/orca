import { SettingsGroupHeader } from '@/components/settings/section-layout/SettingsGroup'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useTranslate } from '@/i18n/use-translate'
import { useCloudWorkspace } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { useAppStore } from '@/store'
import { ORCA_CLOUD_IDLE_SLEEP_MINUTES } from '../../../../../shared/hosted-sandbox/hosted-sandbox-wire'

/** Orca Cloud: start waking a sleeping sandbox on intent (see cloud-predictive-wake.ts). */
export function CloudPredictiveWakeSetting(): React.JSX.Element {
  const enabled = useAppStore((s) => s.settings?.orcaCloudPredictiveWake !== false)
  const updateSettings = useAppStore((s) => s.updateSettings)
  // The control plane reports the idle window with each workspace status; the shared constant
  // is only the fallback before any status has arrived.
  const reported = useCloudWorkspace(
    (s) =>
      Object.values(s.status).find((entry) => entry.status?.idleSleepMinutes)?.status
        ?.idleSleepMinutes ?? null
  )
  return (
    <CloudPredictiveWakeSettingView
      enabled={enabled}
      idleMinutes={reported ?? ORCA_CLOUD_IDLE_SLEEP_MINUTES}
      onToggle={() => void updateSettings({ orcaCloudPredictiveWake: !enabled })}
    />
  )
}

export function CloudPredictiveWakeSettingView({
  enabled,
  idleMinutes,
  onToggle
}: {
  enabled: boolean
  idleMinutes: number
  onToggle: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const title = t(
    'auto.components.settings.orcaCloudPredictiveWake.title',
    'Wake sleeping workspaces early'
  )
  return (
    <div className="space-y-3 border-t border-border/60 pt-5">
      <SettingsGroupHeader
        className="px-0"
        title={t('auto.components.settings.orcaCloudPredictiveWake.group', 'Orca Cloud')}
      />
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>{title}</Label>
          <p className="text-xs text-muted-foreground">
            {t(
              'auto.components.settings.orcaCloudPredictiveWake.description',
              "Starts waking a sleeping sandbox when you point at its workspace or come back to Orca, so it's ready sooner. If you don't open it, it goes back to sleep after {{count}} minutes idle. Early wakes count toward your sandbox hours.",
              {
                count: idleMinutes,
                defaultValue_one:
                  "Starts waking a sleeping sandbox when you point at its workspace or come back to Orca, so it's ready sooner. If you don't open it, it goes back to sleep after {{count}} minute idle. Early wakes count toward your sandbox hours."
              }
            )}
          </p>
        </div>
        <Switch checked={enabled} aria-label={title} onCheckedChange={onToggle} />
      </div>
    </div>
  )
}
