import { SearchableSetting } from './SearchableSetting'
import { Button } from '../ui/button'
import { NetworkInterfacePicker } from '../mobile/NetworkInterfacePicker'
import { MobilePairingQrSection } from './MobilePairingQrSection'
import { SettingsSwitchRow } from './SettingsFormControls'
import { getPeerCollabOverviewSearchEntry } from './peer-collab-settings-search'
import type { MobileNetworkInterface } from './mobile-network-interface-selection'
import { translate } from '@/i18n/i18n'

type PeerCollabHostShareSectionProps = {
  hostEnabled: boolean
  onToggleHostEnabled: () => void
  networkInterfaces: MobileNetworkInterface[]
  selectedAddress: string | undefined
  onSelectedAddressChange: (address: string) => void
  qrDataUrl: string | null
  pairingUrl: string | null
  endpoint: string | null
  loading: boolean
  offerConsumed: boolean
  qrEnlarged: boolean
  codeCopied: boolean
  onGenerate: () => void
  onQrEnlargedChange: (open: boolean) => void
  onCodeCopiedChange: (copied: boolean) => void
  onClearCodeCopiedTimer: () => void
}

export function PeerCollabHostShareSection({
  hostEnabled,
  onToggleHostEnabled,
  networkInterfaces,
  selectedAddress,
  onSelectedAddressChange,
  qrDataUrl,
  pairingUrl,
  endpoint,
  loading,
  offerConsumed,
  qrEnlarged,
  codeCopied,
  onGenerate,
  onQrEnlargedChange,
  onCodeCopiedChange,
  onClearCodeCopiedTimer
}: PeerCollabHostShareSectionProps): React.JSX.Element {
  return (
    <SearchableSetting
      title={getPeerCollabOverviewSearchEntry().title}
      description={getPeerCollabOverviewSearchEntry().description}
      keywords={getPeerCollabOverviewSearchEntry().keywords}
      className="space-y-5"
    >
      <SettingsSwitchRow
        label={translate(
          'auto.components.settings.PeerCollabSettingsPane.hostEnabledLabel',
          'Allow other desktops to connect'
        )}
        description={translate(
          'auto.components.settings.PeerCollabSettingsPane.hostEnabledDescription',
          'Turn this on so other Orca desktops can pair with and view terminals on this computer. Turning it off immediately disconnects any desktop currently connected.'
        )}
        checked={hostEnabled}
        onChange={onToggleHostEnabled}
      />

      <div className="space-y-1">
        <h3 className="text-sm font-medium">
          {translate(
            'auto.components.settings.PeerCollabSettingsPane.startTitle',
            'Start peer sharing'
          )}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.PeerCollabSettingsPane.startDescription',
            'Generate a code, then enter it on the other Orca desktop under Peer Collaboration. Connections stay on your local network only.'
          )}
        </p>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-foreground">
          {translate(
            'auto.components.settings.PeerCollabSettingsPane.addressLabel',
            'This computer’s address'
          )}
        </p>
        <NetworkInterfacePicker
          networkInterfaces={networkInterfaces}
          selectedAddress={selectedAddress}
          onSelectedAddressChange={onSelectedAddressChange}
          disabled={!hostEnabled}
          className="min-w-[220px] justify-between font-normal"
        />
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.PeerCollabSettingsPane.addressDescription',
            'The other desktop must be able to reach this address on Wi‑Fi, Ethernet, or Tailscale.'
          )}
        </p>
      </div>

      <div className="space-y-2">
        <Button
          onClick={onGenerate}
          disabled={loading || !selectedAddress || !hostEnabled}
          size="sm"
        >
          {qrDataUrl != null
            ? translate(
                'auto.components.settings.PeerCollabSettingsPane.regenerate',
                'Regenerate code'
              )
            : translate(
                'auto.components.settings.PeerCollabSettingsPane.generate',
                'Generate code'
              )}
        </Button>
        <p className="text-muted-foreground text-xs">
          {translate(
            'auto.components.settings.PeerCollabSettingsPane.singleUseCodeNotice',
            'Each code admits one desktop and is cleared once that desktop connects. Generate a new code for every desktop you want to add.'
          )}
        </p>
      </div>

      {offerConsumed && hostEnabled ? (
        <p className="text-muted-foreground text-xs">
          {translate(
            'auto.components.settings.PeerCollabSettingsPane.offerConsumed',
            'That code has been used and was cleared. Generate a new one to add another desktop.'
          )}
        </p>
      ) : null}

      {hostEnabled ? (
        <MobilePairingQrSection
          qrDataUrl={qrDataUrl}
          pairingUrl={pairingUrl}
          endpoint={endpoint}
          qrEnlarged={qrEnlarged}
          codeCopied={codeCopied}
          onQrEnlargedChange={onQrEnlargedChange}
          onCodeCopiedChange={onCodeCopiedChange}
          onClearCodeCopiedTimer={onClearCodeCopiedTimer}
          variant="peer"
        />
      ) : null}
    </SearchableSetting>
  )
}
