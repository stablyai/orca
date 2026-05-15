import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { Button } from '@/components/ui/button'
import type { DriverState } from '@/lib/pane-manager/mobile-driver-state'

type Props = {
  driver: DriverState
  hasFitOverride: boolean
  onAction: () => void
  /** Identifier class on the rendered root, used by e2e selectors. */
  rootClassName?: string
}

// Why: see docs/mobile-presence-lock.md. Driving state preserves output streaming
// so the chip mode lets users keep watching; held-fit state has no live output to
// preserve, so it stays loud until Restore.
export function MobileDriverOverlay({
  driver,
  hasFitOverride,
  onAction,
  rootClassName
}: Props): ReactElement | null {
  const isMobileDriving = driver.kind === 'mobile'
  const isHeldAtPhoneFit = !isMobileDriving && hasFitOverride
  const driverClientId = driver.kind === 'mobile' ? driver.clientId : null

  const [collapsed, setCollapsed] = useState(false)

  // Re-expand on driver flip so a new mobile actor is loud, not silent.
  useEffect(() => {
    if (!isMobileDriving) {
      return
    }
    setCollapsed(false)
  }, [isMobileDriving, driverClientId])

  if (!isMobileDriving && !isHeldAtPhoneFit) {
    return null
  }

  if (isHeldAtPhoneFit) {
    return (
      <LoudOverlay
        eyebrow="Held at phone size"
        title="This terminal is sized for your mobile app"
        body="The session is still being held at the dimensions your phone last reported. Restore to use it on your desktop."
        actionLabel="Restore desktop size"
        onAction={onAction}
        tone="held"
        rootClassName={rootClassName}
      />
    )
  }

  if (collapsed) {
    return (
      <LockChip
        onAction={onAction}
        onExpand={() => setCollapsed(false)}
        rootClassName={rootClassName}
      />
    )
  }

  return (
    <LoudOverlay
      eyebrow="Mobile is driving this terminal"
      title="Your keyboard is paused"
      body="Output below is being typed from your phone. Take back to resume typing on the desktop, or collapse to keep watching."
      actionLabel="Take back"
      onAction={onAction}
      onCollapse={() => setCollapsed(true)}
      tone="driving"
      rootClassName={rootClassName}
    />
  )
}

type LoudOverlayProps = {
  eyebrow: string
  title: string
  body: string
  actionLabel: string
  onAction: () => void
  onCollapse?: () => void
  tone: 'driving' | 'held'
  rootClassName?: string
}

function LoudOverlay({
  eyebrow,
  title,
  body,
  actionLabel,
  onAction,
  onCollapse,
  tone,
  rootClassName
}: LoudOverlayProps): ReactElement {
  const eyebrowStyle: CSSProperties = {
    ...EYEBROW_BASE_STYLE,
    color: tone === 'driving' ? 'var(--color-primary)' : 'var(--color-destructive)'
  }
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="mobile-driver-overlay-title"
      style={OVERLAY_STYLE}
      className={rootClassName}
    >
      <div style={CARD_STYLE}>
        <div style={eyebrowStyle}>
          <span aria-hidden="true">●</span>
          <span>{eyebrow}</span>
        </div>
        <div id="mobile-driver-overlay-title" style={TITLE_STYLE}>
          {title}
        </div>
        <div style={BODY_STYLE}>{body}</div>
        <div style={BUTTON_ROW_STYLE}>
          {onCollapse && (
            <Button type="button" variant="outline" size="sm" onClick={onCollapse}>
              Collapse
            </Button>
          )}
          <Button type="button" variant="default" size="sm" onClick={onAction}>
            {actionLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}

type ChipProps = {
  onAction: () => void
  onExpand: () => void
  rootClassName?: string
}

function LockChip({ onAction, onExpand, rootClassName }: ChipProps): ReactElement {
  return (
    <div style={CHIP_WRAP_STYLE} className={rootClassName}>
      <span aria-hidden="true" style={CHIP_DOT_STYLE} />
      <button type="button" style={CHIP_LABEL_STYLE} onClick={onExpand} title="Show details">
        Mobile driving
      </button>
      <Button type="button" variant="default" size="xs" onClick={onAction}>
        Take back
      </Button>
    </div>
  )
}

// Hoisted: stable across renders, no per-instance variation.
const OVERLAY_STYLE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  zIndex: 10,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '24px',
  background: 'rgba(8, 10, 14, 0.72)',
  backdropFilter: 'blur(2px)',
  WebkitBackdropFilter: 'blur(2px)'
}

const CARD_STYLE: CSSProperties = {
  maxWidth: '480px',
  width: '100%',
  background: 'var(--color-card)',
  color: 'var(--color-card-foreground)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-lg)',
  padding: '24px 24px 20px',
  boxShadow: '0 24px 60px rgba(0,0,0,0.45), 0 6px 18px rgba(0,0,0,0.3)',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px'
}

const EYEBROW_BASE_STYLE: CSSProperties = {
  fontSize: '11px',
  fontWeight: 600,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  display: 'flex',
  alignItems: 'center',
  gap: '6px'
}

const TITLE_STYLE: CSSProperties = { fontSize: '17px', fontWeight: 600, lineHeight: 1.25 }

const BODY_STYLE: CSSProperties = {
  fontSize: '13px',
  lineHeight: 1.45,
  color: 'var(--color-muted-foreground)'
}

const BUTTON_ROW_STYLE: CSSProperties = {
  display: 'flex',
  gap: '8px',
  marginTop: '4px',
  justifyContent: 'flex-end'
}

const CHIP_WRAP_STYLE: CSSProperties = {
  position: 'absolute',
  top: '8px',
  right: '8px',
  zIndex: 10,
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  padding: '4px 8px 4px 10px',
  background: 'var(--color-card)',
  color: 'var(--color-card-foreground)',
  border: '1px solid var(--color-border)',
  borderRadius: '999px',
  boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
  fontSize: '12px',
  fontWeight: 500
}

const CHIP_DOT_STYLE: CSSProperties = {
  width: '8px',
  height: '8px',
  borderRadius: '50%',
  background: 'var(--color-primary)',
  boxShadow: '0 0 0 3px rgba(23, 23, 23, 0.15)'
}

const CHIP_LABEL_STYLE: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'inherit',
  cursor: 'pointer',
  padding: 0,
  font: 'inherit'
}
