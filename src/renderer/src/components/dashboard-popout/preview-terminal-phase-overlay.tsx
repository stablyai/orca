import { useEffect, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { terminalPreviewUnavailableMessage } from './terminal-preview-unavailable-message'
import { cn } from '@/lib/utils'

/** `painting` spans a resync's resize/reset/replay, whose half-parsed frame read as "broken UI". */
export type PreviewPhase = 'connecting' | 'painting' | 'live' | 'unavailable'

// A resync that completes faster than this never shows the veil at all.
const PAINTING_VEIL_DELAY_MS = 80

/** Shown while a session has no live pty yet — before connect, or before it spawns at all. */
export function PreviewStartingNotice(): React.JSX.Element {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] text-muted-foreground/50 animate-pulse select-none">
      {translate('dashboardPopout.terminal.starting', 'Starting session…')}
    </div>
  )
}

/** Purely visual veil: nothing underneath unmounts or resizes, so a fast resync costs nothing. */
export function PreviewPhaseOverlay({
  phase,
  ptyId,
  ptyGone,
  background
}: {
  phase: PreviewPhase
  ptyId: string
  ptyGone: boolean
  background: string | undefined
}): React.JSX.Element | null {
  const [veilVisible, setVeilVisible] = useState(false)

  useEffect(() => {
    if (phase !== 'painting') {
      setVeilVisible(false)
      return
    }
    const timer = window.setTimeout(() => setVeilVisible(true), PAINTING_VEIL_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [phase])

  if (ptyGone) {
    return (
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-2.5 py-8 text-center text-[11px] text-muted-foreground">
        {terminalPreviewUnavailableMessage({ ptyId })}
      </div>
    )
  }
  if (phase === 'connecting') {
    return <PreviewStartingNotice />
  }
  if (phase === 'unavailable') {
    return (
      <div
        role="status"
        className="pointer-events-none absolute bottom-2 inset-x-2 z-10 bg-background px-2 py-1 text-center text-[11px] text-muted-foreground"
      >
        {translate('dashboardPopout.terminal.unavailable', 'Preview unavailable. Retrying…')}
      </div>
    )
  }
  return (
    <div
      aria-hidden
      data-testid="preview-phase-veil"
      data-visible={veilVisible ? 'true' : 'false'}
      className={cn(
        'pointer-events-none absolute inset-0 z-10 bg-background transition-opacity duration-150',
        veilVisible ? 'opacity-100' : 'opacity-0'
      )}
      style={background ? { backgroundColor: background } : undefined}
    />
  )
}
