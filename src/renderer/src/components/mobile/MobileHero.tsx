import { cn } from '../../lib/utils'
import type { MobileNetworkInterface } from '../settings/mobile-network-interface-selection'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

export type Platform = 'ios' | 'android'
export type StepIndex = 0 | 1

export type PairedDevice = {
  deviceId: string
  name: string
  pairedAt: number
  lastSeenAt: number
}

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

export function HeroIntro({ onStart }: { onStart: () => void }): React.JSX.Element {
  return (
    <div>
      <div className="mp-eyebrow-row">
        <span className="mp-eyebrow">Orca Mobile</span>
      </div>
      <h1 className="mp-h1">Your workspaces, in your pocket.</h1>
      <p className="mp-lead">
        Control Orca from your phone. Check on agents, review changes, and kick off tasks while
        you&apos;re away from your desk.
      </p>
      <div className="mp-cta-row">
        <button type="button" className="mp-primary-action" onClick={onStart}>
          Get started
          <ArrowRightIcon />
        </button>
      </div>
    </div>
  )
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
        <span className="mp-eyebrow">Orca Mobile</span>
      </div>
      <h1 className="mp-h1">
        {devices.length === 1 ? 'Your phone is paired.' : 'Your phones are paired.'}
      </h1>
      <p className="mp-lead-sm">
        Open Orca Mobile to pick up where you left off, or pair another device.
      </p>
      <ul className="mp-paired-list">
        {devices.map((device) => {
          const revoking = revokingDeviceIds.includes(device.deviceId)
          return (
            <li key={device.deviceId} className="mp-paired-row">
              <div className="mp-paired-icon">
                <PhoneSmallIcon />
              </div>
              <div className="mp-paired-main">
                <div className="mp-paired-name">{device.name}</div>
                <div className="mp-paired-meta">
                  Paired {new Date(device.pairedAt).toLocaleDateString()}
                </div>
              </div>
              <button
                type="button"
                className="mp-paired-revoke"
                onClick={() => onRevoke(device.deviceId)}
                disabled={revoking}
                aria-label={`Revoke ${device.name}`}
                title="Revoke device"
              >
                <TrashIcon />
              </button>
            </li>
          )
        })}
      </ul>
      <div className="mp-flow-actions">
        <button type="button" className="mp-flow-back" onClick={onPairAnother}>
          <ArrowLeftIcon />
          Pair another device
        </button>
        <span />
      </div>
    </div>
  )
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
    <div>
      <div className="mp-flow-viewport">
        <div className={cn('mp-flow-screen', stepIdx === 0 ? 'is-active' : 'is-past')}>
          <div className="mp-step2-layout">
            <div className="mp-step2-copy">
              <div className="mp-eyebrow-row">
                <div className="mp-step-num">{stepIdx + 1}</div>
                <span className="mp-eyebrow">Step 1 of 2</span>
              </div>
              <h2 className="mp-h2">Get the app.</h2>
              <p className="mp-lead-sm">
                Scan the QR with your phone or open the install link to grab Orca Mobile.
              </p>
              <div className="mp-tab-toggle">
                <button
                  type="button"
                  className={cn(platform === 'ios' && 'is-active')}
                  aria-pressed={platform === 'ios'}
                  onClick={() => onPlatformChange('ios')}
                >
                  iOS
                </button>
                <button
                  type="button"
                  className={cn(platform === 'android' && 'is-active')}
                  aria-pressed={platform === 'android'}
                  onClick={() => onPlatformChange('android')}
                >
                  Android
                </button>
              </div>
              <div className="mp-inline-actions">
                <button type="button" className="mp-ghost-action" onClick={onOpenInstallUrl}>
                  {installCopy.ctaLabel}
                </button>
                <button type="button" className="mp-text-link" onClick={onCopyInstallUrl}>
                  <CopyIcon />
                  Copy install link
                </button>
              </div>
            </div>
            <div className="mp-qr" aria-label="Install QR code">
              {installQrUrl ? <img src={installQrUrl} alt="Install QR" /> : null}
            </div>
          </div>
        </div>

        <div className={cn('mp-flow-screen', stepIdx === 1 && 'is-active')}>
          <div className="mp-step2-layout">
            <div className="mp-step2-copy">
              <div className="mp-eyebrow-row">
                <div className="mp-step-num">2</div>
                <span className="mp-eyebrow">Step 2 of 2</span>
              </div>
              <h2 className="mp-h2">Pair this {getDeviceLabel()}.</h2>
              <p className="mp-lead-sm">
                Open Orca Mobile, tap <strong>Pair Desktop</strong>, and scan the code.
              </p>

              <div className="mp-network-row">
                <span className="mp-network-label">Network</span>
                <Select
                  value={selectedAddress ?? ''}
                  onValueChange={onSelectedAddressChange}
                  disabled={networkInterfaces.length === 0}
                >
                  <SelectTrigger
                    size="sm"
                    className="mp-network-select"
                    aria-label="Network interface to advertise"
                  >
                    <SelectValue placeholder="No interfaces found" />
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
                  aria-label="Refresh network interfaces"
                  title="Refresh network interfaces"
                >
                  <RefreshIcon />
                </button>
              </div>

              <div className="mp-inline-actions">
                <span className="mp-action-divider">Can&apos;t scan?</span>
                <button
                  type="button"
                  className="mp-text-link"
                  onClick={onCopyPairingCode}
                  disabled={!pairingUrl || pairLoading}
                >
                  <CopyIcon />
                  Copy pairing code
                </button>
              </div>
            </div>
            <div className="mp-qr-stack">
              <div
                className="mp-qr"
                aria-label="Pairing QR code"
                aria-busy={pairLoading && !pairQrDataUrl}
              >
                {pairQrDataUrl ? (
                  <img src={pairQrDataUrl} alt="Pairing QR" />
                ) : pairLoading ? (
                  <span className="mp-qr-loading">Generating…</span>
                ) : null}
              </div>
              <button
                type="button"
                className="mp-link-under"
                onClick={onRegeneratePairing}
                disabled={pairLoading}
              >
                {pairLoading ? 'Generating…' : pairQrDataUrl ? 'Regenerate code' : 'Generate code'}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="mp-flow-actions">
        <button type="button" className="mp-flow-back" onClick={onBack}>
          <ArrowLeftIcon />
          Back
        </button>
        {isLast ? (
          onDone ? (
            <button type="button" className="mp-primary-action" onClick={onDone}>
              Done
              <ArrowRightIcon />
            </button>
          ) : (
            <span />
          )
        ) : (
          <button type="button" className="mp-flow-continue" onClick={onContinue}>
            Continue
            <ArrowRightIcon />
          </button>
        )}
      </div>
    </div>
  )
}

function ArrowRightIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  )
}

function ArrowLeftIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
      <path d="m15 18-6-6 6-6" />
    </svg>
  )
}

function CopyIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

function PhoneSmallIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <rect x="6" y="3" width="12" height="18" rx="2.5" />
      <line x1="11" y1="18" x2="13" y2="18" />
    </svg>
  )
}

function TrashIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6 18 20a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  )
}

function RefreshIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 4v5h-5" />
      <path d="M3 12a9 9 0 0 0 15 6.7" />
      <path d="M3 20v-5h5" />
    </svg>
  )
}
