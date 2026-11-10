import { SettingsGroupHeader } from '@/components/settings/section-layout/SettingsGroup'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { ORCA_CLOUD_IDLE_SLEEP_MINUTES } from '../../../../../shared/hosted-sandbox/hosted-sandbox-wire'

/** Orca Cloud: start waking a sleeping sandbox on intent (see cloud-predictive-wake.ts). */
export function CloudPredictiveWakeSetting(): React.JSX.Element {
  const t = useTranslate()
  const enabled = useAppStore((s) => s.settings?.orcaCloudPredictiveWake !== false)
  const updateSettings = useAppStore((s) => s.updateSettings)
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
                count: ORCA_CLOUD_IDLE_SLEEP_MINUTES,
                defaultValue_one:
                  "Starts waking a sleeping sandbox when you point at its workspace or come back to Orca, so it's ready sooner. If you don't open it, it goes back to sleep after {{count}} minute idle. Early wakes count toward your sandbox hours."
              }
            )}
          </p>
        </div>
        <Switch
          checked={enabled}
          aria-label={title}
          onCheckedChange={() => void updateSettings({ orcaCloudPredictiveWake: !enabled })}
        />
      </div>
    </div>
  )
}
