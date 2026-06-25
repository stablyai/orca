import { ArrowLeft, ArrowRight, Copy, RefreshCw } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { MobileNetworkInterface } from '../settings/mobile-network-interface-selection'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { AndroidLogo, IosBrandIcon } from './MobileBrandIcons'
export { HeroIntro } from './MobileHeroIntro'
export { HeroPaired, type PairedDevice } from './MobileHeroPairedDevices'
import { translate } from '@/i18n/i18n'

export type Platform = 'ios' | 'android'
export type StepIndex = 0 | 1

// Why: header copy needs to refer to the *user's* device by its native name.
function getDeviceLabel(): string {
  const ua = navigator.userAgent
  if (ua.includes('Mac')) {
    return 'Mac'
  }
  if (ua.includes('Windows')) {
    return 'PC'
  }
  return 'computer'
}

type HeroFlowProps = {
  stepIdx: StepIndex
  platform: Platform
  onPlatformChange: (next: Platform) => void
  installQrUrl: string | null
  installCopy: { description: string; ctaLabel: string; url: string }
  onOpenInstallUrl: () => void
  onCopyInstallUrl: () => void
  pairQrDataUrl: string | null
  pairingUrl: string | null
  pairLoading: boolean
  onRegeneratePairing: () => void
  onCopyPairingCode: () => void
  networkInterfaces: readonly MobileNetworkInterface[]
  selectedAddress: string | undefined
  onSelectedAddressChange: (address: string) => void
  onRefreshNetworkInterfaces: () => void
  refreshingNetworkInterfaces: boolean
  onBack: () => void
  onContinue: () => void
  onDone?: () => void
}

export function HeroFlow({
  stepIdx,
  platform,
  onPlatformChange,
  installQrUrl,
  installCopy,
  onOpenInstallUrl,
  onCopyInstallUrl,
  pairQrDataUrl,
  pairingUrl,
  pairLoading,
  onRegeneratePairing,
  onCopyPairingCode,
  networkInterfaces,
  selectedAddress,
  onSelectedAddressChange,
  onRefreshNetworkInterfaces,
  refreshingNetworkInterfaces,
  onBack,
  onContinue,
  onDone
}: HeroFlowProps): React.JSX.Element {
  const isLast = stepIdx === 1

  return (
    <div className="mp-flow-card">
      <div className="mp-flow-viewport">
        <div className={cn('mp-flow-screen', stepIdx === 0 ? 'is-active' : 'is-past')}>
          <div className="mp-step2-layout">
            <div className="mp-step2-copy">
              <div className="mp-eyebrow-row">
                <div className="mp-step-num">{stepIdx + 1}</div>
                <span className="mp-eyebrow">
                  {translate('auto.components.mobile.MobileHero.92ddfdfa1f', 'Step 1 of 2')}
                </span>
              </div>
              <h2 className="mp-h2">
                {translate('auto.components.mobile.MobileHero.0d9b33299e', 'Get the app.')}
              </h2>
              <p className="mp-lead-sm">
                {translate(
                  'auto.components.mobile.MobileHero.e75647ace0',
                  'Scan the QR with your phone or open the install link to grab Orca Mobile.'
                )}
              </p>
              <div className="mp-tab-toggle">
                <button
                  type="button"
                  className={cn(platform === 'ios' && 'is-active')}
                  aria-pressed={platform === 'ios'}
                  onClick={() => onPlatformChange('ios')}
                >
                  <IosBrandIcon />
                  {translate('auto.components.mobile.MobileHero.711e6f4b47', 'iOS')}
                </button>
                <button
                  type="button"
                  className={cn(platform === 'android' && 'is-active')}
                  aria-pressed={platform === 'android'}
                  onClick={() => onPlatformChange('android')}
                >
                  <AndroidLogo />
                  {translate('auto.components.mobile.MobileHero.ac1eb64952', 'Android')}
                </button>
              </div>
              <div className="mp-inline-actions">
                <button type="button" className="mp-ghost-action" onClick={onOpenInstallUrl}>
                  {installCopy.ctaLabel}
                </button>
                <button type="button" className="mp-text-link" onClick={onCopyInstallUrl}>
                  <Copy className="size-3.5" />
                  {translate('auto.components.mobile.MobileHero.aa97420ba4', 'Copy install link')}
                </button>
              </div>
            </div>
            <div
              className="mp-qr mp-qr-large"
              aria-label={translate(
                'auto.components.mobile.MobileHero.7af266b80d',
                'Install QR code'
              )}
            >
              {installQrUrl ? (
                <img
                  src={installQrUrl}
                  alt={translate('auto.components.mobile.MobileHero.3241f3c26a', 'Install QR')}
                />
              ) : null}
            </div>
          </div>
        </div>

        <div className={cn('mp-flow-screen', stepIdx === 1 && 'is-active')}>
          <div className="mp-step2-layout">
            <div className="mp-step2-copy">
              <div className="mp-eyebrow-row">
                <div className="mp-step-num">2</div>
                <span className="mp-eyebrow">
                  {translate('auto.components.mobile.MobileHero.3960f5c339', 'Step 2 of 2')}
                </span>
              </div>
              <h2 className="mp-h2">
                {translate('auto.components.mobile.MobileHero.901c98bb93', 'Pair this')}{' '}
                {getDeviceLabel()}.
              </h2>
              <p className="mp-lead-sm">
                {translate('auto.components.mobile.MobileHero.d1495e5e64', 'Open Orca Mobile, tap')}{' '}
                <strong>
                  {translate('auto.components.mobile.MobileHero.3aa7bb2d8b', 'Pair Desktop')}
                </strong>
                {translate('auto.components.mobile.MobileHero.2f077ef4eb', ', and scan the code.')}
              </p>

              <div className="mp-network-row">
                <span className="mp-network-label">
                  {translate('auto.components.mobile.MobileHero.dfd2aa9d5d', 'Network')}
                </span>
                <Select
                  value={selectedAddress ?? ''}
                  onValueChange={onSelectedAddressChange}
                  disabled={networkInterfaces.length === 0}
                >
                  <SelectTrigger
                    size="sm"
                    className="mp-network-select"
                    aria-label={translate(
                      'auto.components.mobile.MobileHero.79d2f480da',
                      'Network interface to advertise'
                    )}
                  >
                    <SelectValue
                      placeholder={translate(
                        'auto.components.mobile.MobileHero.ca85e595a7',
                        'No interfaces found'
                      )}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {networkInterfaces.map((iface) => (
                      <SelectItem key={`${iface.name}-${iface.address}`} value={iface.address}>
                        {iface.address} ({iface.name})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <button
                  type="button"
                  className={cn('mp-network-refresh', refreshingNetworkInterfaces && 'is-spinning')}
                  onClick={onRefreshNetworkInterfaces}
                  disabled={refreshingNetworkInterfaces}
                  aria-label={translate(
                    'auto.components.mobile.MobileHero.85067b9e06',
                    'Refresh network interfaces'
                  )}
                  title={translate(
                    'auto.components.mobile.MobileHero.85067b9e06',
                    'Refresh network interfaces'
                  )}
                >
                  <RefreshCw className="size-3.5" />
                </button>
              </div>

              <div className="mp-inline-actions">
                <span className="mp-action-divider">
                  {translate('auto.components.mobile.MobileHero.4c1df4eba7', "Can't scan?")}
                </span>
                <button
                  type="button"
                  className="mp-text-link"
                  onClick={onCopyPairingCode}
                  disabled={!pairingUrl || pairLoading}
                >
                  <Copy className="size-3.5" />
                  {translate('auto.components.mobile.MobileHero.010dddcf27', 'Copy pairing code')}
                </button>
              </div>
            </div>
            <div className="mp-qr-stack">
              <div
                className="mp-qr mp-qr-large"
                aria-label={translate(
                  'auto.components.mobile.MobileHero.bb0074ce11',
                  'Pairing QR code'
                )}
                aria-busy={pairLoading && !pairQrDataUrl}
              >
                {pairQrDataUrl ? (
                  <img
                    src={pairQrDataUrl}
                    alt={translate('auto.components.mobile.MobileHero.27735e5f4e', 'Pairing QR')}
                  />
                ) : pairLoading ? (
                  <span className="mp-qr-loading">
                    {translate('auto.components.mobile.MobileHero.65b3f2e8bc', 'Generating…')}
                  </span>
                ) : null}
              </div>
              <button
                type="button"
                className="mp-link-under"
                onClick={onRegeneratePairing}
                disabled={pairLoading}
              >
                {pairLoading
                  ? translate('auto.components.mobile.MobileHero.65b3f2e8bc', 'Generating…')
                  : pairQrDataUrl
                    ? translate('auto.components.mobile.MobileHero.e59a252eca', 'Regenerate code')
                    : translate('auto.components.mobile.MobileHero.a6cffbbb0b', 'Generate code')}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="mp-flow-actions">
        <button type="button" className="mp-flow-back" onClick={onBack}>
          <ArrowLeft className="size-3" />
          {translate('auto.components.mobile.MobileHero.b622eba64d', 'Back')}
        </button>
        {isLast ? (
          onDone ? (
            <button
              type="button"
              className="mp-primary-action mp-flow-primary-action"
              onClick={onDone}
            >
              {translate('auto.components.mobile.MobileHero.3f90dbd274', 'Done')}
              <ArrowRight className="size-3.5" />
            </button>
          ) : (
            <span />
          )
        ) : (
          <button
            type="button"
            className="mp-flow-continue mp-flow-primary-action"
            onClick={onContinue}
          >
            {translate('auto.components.mobile.MobileHero.a8fb43cf1c', 'Continue')}
            <ArrowRight className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}
