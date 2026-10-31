import { useId } from 'react'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { Switch } from '../ui/switch'
import { useMobilePairingRelayLocalPath } from './use-mobile-pairing-relay-local-path'

export function MobilePairingLocalPathSwitch(): React.JSX.Element {
  const t = useTranslate()
  const enabled = useMobilePairingRelayLocalPath()
  const updateSettings = useAppStore((state) => state.updateSettings)
  const labelId = useId()
  return (
    <div className="flex max-w-xl items-start justify-between gap-3">
      <div className="space-y-0.5">
        <p id={labelId} className="m-0 text-xs font-medium text-foreground">
          {t('auto.components.mobile.MobilePairingLocalPathSwitch.label', 'Local path')}
        </p>
        {enabled ? null : (
          <p className="m-0 text-xs text-muted-foreground">
            {t(
              'auto.components.mobile.MobilePairingLocalPathSwitch.relayOnly',
              'Relay only: pairing won’t open this computer to your Wi‑Fi or Tailscale network.'
            )}
          </p>
        )}
      </div>
      <Switch
        aria-labelledby={labelId}
        checked={enabled}
        onCheckedChange={(checked) => void updateSettings({ mobilePairingRelayLocalPath: checked })}
      />
    </div>
  )
}
