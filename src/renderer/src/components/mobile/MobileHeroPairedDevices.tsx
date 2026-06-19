import { Smartphone, Trash2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'

export type PairedDevice = {
  deviceId: string
  name: string
  pairedAt: number
  lastSeenAt: number
}

type HeroPairedProps = {
  devices: readonly PairedDevice[]
  onPairAnother: () => void
  onRevoke: (deviceId: string) => void
  revokingDeviceIds: readonly string[]
}

export function HeroPaired({
  devices,
  onPairAnother,
  onRevoke,
  revokingDeviceIds
}: HeroPairedProps): React.JSX.Element {
  return (
    <div>
      <div className="mp-eyebrow-row">
        <span className="mp-eyebrow">
          {translate('auto.components.mobile.MobileHero.5410d55d79', 'Orca Mobile')}
        </span>
      </div>
      <h1 className="mp-h1">
        {devices.length === 1
          ? translate('auto.components.mobile.MobileHero.051978a785', 'Your phone is paired.')
          : translate('auto.components.mobile.MobileHero.d0b52871ce', 'Your phones are paired.')}
      </h1>
      <p className="mp-lead-sm">
        {translate(
          'auto.components.mobile.MobileHero.266c18c105',
          'Open Orca Mobile to pick up where you left off, or pair another device.'
        )}
      </p>
      <ul className="mp-paired-list">
        {devices.map((device) => {
          const revoking = revokingDeviceIds.includes(device.deviceId)
          return (
            <li key={device.deviceId} className="mp-paired-row">
              <div className="mp-paired-icon">
                <Smartphone className="size-4" />
              </div>
              <div className="mp-paired-main">
                <div className="mp-paired-name">{device.name}</div>
                <div className="mp-paired-meta">
                  {translate('auto.components.mobile.MobileHero.94829abdb1', 'Paired')}{' '}
                  {new Date(device.pairedAt).toLocaleDateString()}
                </div>
              </div>
              <button
                type="button"
                className="mp-paired-revoke"
                onClick={() => onRevoke(device.deviceId)}
                disabled={revoking}
                aria-label={translate(
                  'auto.components.mobile.MobileHero.34f878d04f',
                  'Revoke {{value0}}',
                  { value0: device.name }
                )}
                title={translate('auto.components.mobile.MobileHero.f9cbf4bb53', 'Revoke device')}
              >
                <Trash2 className="size-3.5" />
              </button>
            </li>
          )
        })}
      </ul>
      <div className="mp-flow-actions">
        <button type="button" className="mp-secondary-action" onClick={onPairAnother}>
          <Smartphone className="size-3.5" />
          {translate('auto.components.mobile.MobileHero.ff48d9d520', 'Pair another device')}
        </button>
        <span />
      </div>
    </div>
  )
}
