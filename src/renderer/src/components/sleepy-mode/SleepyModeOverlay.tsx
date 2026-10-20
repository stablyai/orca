import { useCallback, useEffect, useMemo, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import { getAgentStatusEpochNow } from '@/lib/agent-status-epoch-clock'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import {
  normalizeSleepyModeIdleMinutes,
  sleepyModeIdleDelayMs
} from '../../../../shared/sleepy-mode-settings'
import {
  PET_BOB_KEYFRAMES_CSS,
  PetSprite,
  useDocumentVisible,
  usePetAnimationName
} from '../pet/PetSprite'
import { useAppStore } from '../../store'
import { summarizeSleepyModeFleet } from './sleepy-mode-fleet-summary'
import { useSleepyModeIdleTrigger } from './use-sleepy-mode-idle-trigger'

const CLOCK_TICK_MS = 1_000

function useClock(running: boolean): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    if (!running) {
      return
    }
    setNow(new Date())
    const timer = window.setInterval(() => setNow(new Date()), CLOCK_TICK_MS)
    return () => window.clearInterval(timer)
  }, [running])
  return now
}

function FleetLine(): React.JSX.Element {
  const agentStatusByPaneKey = useAppStore((s) => s.agentStatusByPaneKey)
  const agentStatusEpoch = useAppStore((s) => s.agentStatusEpoch)
  // Why: read the boundary clock in render so a turn that went stale while the scene
  // was up stops being reported as live work.
  const summary = summarizeSleepyModeFleet({
    entries: Object.values(agentStatusByPaneKey),
    now: getAgentStatusEpochNow(agentStatusEpoch),
    staleAfterMs: AGENT_STATUS_STALE_AFTER_MS
  })
  const reducedMotion = usePrefersReducedMotion()

  const parts: string[] = []
  if (summary.working > 0) {
    parts.push(
      translate('auto.components.sleepy-mode.SleepyModeOverlay.working', '{{count}} working', {
        count: summary.working
      })
    )
  }
  if (summary.waiting > 0) {
    parts.push(
      translate('auto.components.sleepy-mode.SleepyModeOverlay.waiting', '{{count}} waiting', {
        count: summary.waiting
      })
    )
  }
  if (summary.done > 0) {
    parts.push(
      translate('auto.components.sleepy-mode.SleepyModeOverlay.done', '{{count}} done', {
        count: summary.done
      })
    )
  }

  if (parts.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {translate('auto.components.sleepy-mode.SleepyModeOverlay.quiet', 'No agents working')}
      </p>
    )
  }

  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <span
        aria-hidden
        className={
          summary.working > 0 && !reducedMotion
            ? 'size-1.5 animate-pulse rounded-full bg-foreground'
            : 'size-1.5 rounded-full bg-muted-foreground'
        }
      />
      {parts.join(' · ')}
    </p>
  )
}

const SCENE_PET_SIZE = 260

/** The pet, centred and idle-bobbing, animating off the same live agent state the corner overlay reads. */
function ScenePet(): React.JSX.Element | null {
  const documentVisible = useDocumentVisible()
  const reducedMotion = usePrefersReducedMotion()
  // Why: not gated on experimentalPet — that flag owns the draggable corner overlay, not the
  // artwork. An explicit "Hide pet" is a preference about the pet itself, so the scene honours it.
  const petHidden = useAppStore((s) => s.petVisible === false)
  const animationName = usePetAnimationName(false, null, false)
  const animate = documentVisible && !reducedMotion

  if (petHidden) {
    return null
  }

  return (
    <div aria-hidden className="flex items-end justify-center" style={{ height: SCENE_PET_SIZE }}>
      <style>{PET_BOB_KEYFRAMES_CSS}</style>
      <div
        style={{
          animation: 'pet-bob 1.2s ease-in-out infinite',
          animationPlayState: animate ? 'running' : 'paused'
        }}
      >
        <PetSprite size={SCENE_PET_SIZE} animate={animate} animationName={animationName} />
      </div>
    </div>
  )
}

/**
 * A full-window resting screen for a fleet left running. It covers the workspace (and whatever
 * the agents have on screen) with a clock and a live fleet summary, and gets out of the way on
 * the first input. Display sleep is not touched here — "Keep computer awake" owns that.
 */
export default function SleepyModeOverlay(): React.JSX.Element | null {
  const active = useAppStore((s) => s.sleepyModeActive)
  const setActive = useAppStore((s) => s.setSleepyModeActive)
  const idleMinutes = useAppStore((s) => s.settings?.sleepyModeIdleMinutes)

  const delayMs = sleepyModeIdleDelayMs(normalizeSleepyModeIdleMinutes(idleMinutes))
  const start = useCallback(() => setActive(true), [setActive])
  useSleepyModeIdleTrigger({ delayMs, suspended: active, onIdle: start })

  const now = useClock(active)
  const timeFormat = useMemo(
    () => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }),
    []
  )
  const dateFormat = useMemo(
    () => new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }),
    []
  )

  useEffect(() => {
    if (!active) {
      return
    }
    // Why: consume the wake input. Without this the key that dismisses the scene still
    // reaches the terminal or editor underneath and types, submits, or fires a shortcut.
    const wake = (event: Event): void => {
      event.preventDefault()
      event.stopImmediatePropagation()
      setActive(false)
    }
    // Capture phase: xterm and Monaco stop plenty of events before they reach window.
    const options = { capture: true, passive: false } as const
    window.addEventListener('keydown', wake, options)
    window.addEventListener('pointerdown', wake, options)
    window.addEventListener('wheel', wake, options)
    return () => {
      window.removeEventListener('keydown', wake, options)
      window.removeEventListener('pointerdown', wake, options)
      window.removeEventListener('wheel', wake, options)
    }
  }, [active, setActive])

  if (!active) {
    return null
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={translate('auto.components.sleepy-mode.SleepyModeOverlay.label', 'Sleepy Mode')}
      className="sleepy-mode-scene fixed inset-0 z-[95] flex flex-col items-center justify-center gap-3"
    >
      <ScenePet />
      <p className="text-7xl font-light tabular-nums tracking-tight text-foreground">
        {timeFormat.format(now)}
      </p>
      <p className="text-sm text-muted-foreground">{dateFormat.format(now)}</p>
      <FleetLine />
      <p className="absolute bottom-10 text-xs text-muted-foreground">
        {translate(
          'auto.components.sleepy-mode.SleepyModeOverlay.dismissHint',
          'Press any key to wake'
        )}
      </p>
    </div>
  )
}
