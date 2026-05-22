import { cn } from '../../lib/utils'

export type Platform = 'ios' | 'android'
export type StepIndex = 0 | 1

const STEP_TITLES = ['Get the app', 'Pair this Mac'] as const

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

type HeroFlowProps = {
  stepIdx: StepIndex
  platform: Platform
  onPlatformChange: (next: Platform) => void
  installQrUrl: string | null
  installCopy: { description: string; ctaLabel: string; url: string }
  onOpenInstallUrl: () => void
  onCopyInstallUrl: () => void
  pairQrDataUrl: string | null
  pairEndpoint: string | null
  pairingUrl: string | null
  pairLoading: boolean
  onRegeneratePairing: () => void
  onBack: () => void
  onContinue: () => void
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
  pairEndpoint,
  pairingUrl,
  pairLoading,
  onRegeneratePairing,
  onBack,
  onContinue
}: HeroFlowProps): React.JSX.Element {
  const isLast = stepIdx === 1

  return (
    <div>
      <div className="mp-flow-header">
        <div className="mp-flow-step-head">
          <div className="mp-step-num">{stepIdx + 1}</div>
          <div className="mp-step-title">{STEP_TITLES[stepIdx]}</div>
        </div>
      </div>

      <div className="mp-flow-viewport">
        <div className={cn('mp-flow-screen', stepIdx === 0 ? 'is-active' : 'is-past')}>
          <div className="mp-step-body">
            <div className="mp-platform-toggle" role="tablist" aria-label="Phone platform">
              <button
                type="button"
                className={cn(platform === 'ios' && 'is-active')}
                onClick={() => onPlatformChange('ios')}
              >
                iOS
              </button>
              <button
                type="button"
                className={cn(platform === 'android' && 'is-active')}
                onClick={() => onPlatformChange('android')}
              >
                Android
              </button>
            </div>

            <div className="mp-install-row">
              <div>
                <div>{installCopy.description}</div>
                <div className="mp-small-actions">
                  <button type="button" className="mp-ghost-action" onClick={onOpenInstallUrl}>
                    {installCopy.ctaLabel}
                  </button>
                  <button type="button" className="mp-ghost-action" onClick={onCopyInstallUrl}>
                    <CopyIcon />
                    Copy link
                  </button>
                </div>
              </div>
              <div className="mp-qr" aria-label="Install QR code">
                {installQrUrl ? <img src={installQrUrl} alt="Install QR" /> : null}
              </div>
            </div>
          </div>
        </div>

        <div className={cn('mp-flow-screen', stepIdx === 1 && 'is-active')}>
          <div className="mp-step-body">
            From the phone, hit <strong>Pair Desktop</strong> and scan the QR below.
            <div className="mp-pair-settings" role="group" aria-label="Pairing details">
              <div className="mp-pair-row">
                <span className="mp-pair-icon" aria-hidden>
                  <ServerIcon />
                </span>
                <span className="mp-pair-label">Endpoint</span>
                <span className="mp-pair-value">
                  {pairEndpoint ?? (pairLoading ? 'Generating…' : 'Not generated yet')}
                </span>
              </div>
              <div className="mp-pair-separator" />
              <div className="mp-pair-row mp-pair-row-qr">
                <span className="mp-pair-icon" aria-hidden>
                  <QrIcon />
                </span>
                <span className="mp-pair-label">Pairing QR</span>
                <div className="mp-qr" aria-label="Pairing QR code">
                  {pairQrDataUrl ? <img src={pairQrDataUrl} alt="Pairing QR" /> : null}
                </div>
              </div>
              {pairingUrl ? (
                <>
                  <div className="mp-pair-separator" />
                  <div className="mp-pair-row">
                    <span className="mp-pair-icon" aria-hidden>
                      <LinkIcon />
                    </span>
                    <span className="mp-pair-label">Pairing URL</span>
                    <span
                      className="mp-pair-value"
                      style={{
                        maxWidth: 220,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {pairingUrl}
                    </span>
                  </div>
                </>
              ) : null}
            </div>
            <div className="mp-pair-settings">
              <button
                type="button"
                className="mp-pair-action-row"
                onClick={onRegeneratePairing}
                disabled={pairLoading}
              >
                <span className="mp-pair-icon" aria-hidden>
                  <RotateIcon />
                </span>
                <span className="mp-pair-label">
                  {pairLoading
                    ? 'Generating…'
                    : pairQrDataUrl
                      ? 'Regenerate pairing code'
                      : 'Generate pairing code'}
                </span>
                <span className="mp-pair-meta">Rotates each tap</span>
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
        <button
          type="button"
          className={cn('mp-flow-continue', isLast && 'is-hidden')}
          onClick={onContinue}
          aria-hidden={isLast}
        >
          Continue
          <ArrowRightIcon />
        </button>
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

function ServerIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  )
}

function QrIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <path d="M14 14h3v3" />
      <path d="M21 14v3" />
      <path d="M14 21h3" />
    </svg>
  )
}

function RotateIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 4v5h-5" />
    </svg>
  )
}

function LinkIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1 1" />
      <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1-1" />
    </svg>
  )
}
