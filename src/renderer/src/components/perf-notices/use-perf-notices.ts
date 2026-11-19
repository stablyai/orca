import { useEffect } from 'react'
import { useAppStore } from '@/store/index'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import type { PerfNoticeSignals } from '../../../../shared/diagnostics/perf-notice-signals'
import { formatMemory } from '../status-bar/resources/popover/resource-usage-metrics'
import { splitSnapshotByOwner } from '../status-bar/resources/popover/resource-owner-split'
import { canShowPerfNotice } from './perf-notice-ledger'
import {
  availableFraction,
  countIdleAgents,
  isDiskAlmostFull,
  isHiddenBrowserTabsDue,
  isIdleAgentsDue,
  LOW_MEMORY_FRACTION,
  TIGHT_MEMORY_FRACTION,
  PERF_NOTICE_OFFERS_AGENT_SLEEP
} from './perf-notice-rules'
import { showPerfNotice, type PerfNotice } from './perf-notice-toast'

const MINUTE = 60_000
const LOW_MEMORY_HOLD_MS = 2 * MINUTE
const OWNER_SHARE_RECHECK_MS = 60 * MINUTE
const AGENT_SLEEP_IDLE_MS = 30 * MINUTE
const TYPING_QUIET_MS = 5_000
const USER_AWAY_SECONDS = 5 * 60

const CADENCE = {
  low: 30_000,
  tight: MINUTE,
  healthy: 5 * MINUTE,
  waiting: 15_000
} as const

type Tracking = { lowSince: number | null; ownerShareCheckedAt: number }

/** Memory-low needs proof that Orca's terminals, not other apps, hold the memory: one snapshot, at most hourly. */
async function memoryLowNotice(now: number): Promise<PerfNotice | null> {
  const snapshot = await window.api.memory.getSnapshot()
  const state = useAppStore.getState()
  const split = splitSnapshotByOwner(snapshot, state.agentStatusByPaneKey)
  const started = split.orca.memory + split.agents.memory + split.yourProcesses.memory
  if (snapshot.host.usedMemory <= 0 || started / snapshot.host.usedMemory < 0.4) {
    return null
  }
  if (
    PERF_NOTICE_OFFERS_AGENT_SLEEP &&
    !state.settings?.experimentalAgentHibernation &&
    countIdleAgents(state, now, AGENT_SLEEP_IDLE_MS).terminal > 0
  ) {
    return { id: 'memory-low', variant: 'agent-sleep' }
  }
  return {
    id: 'memory-low',
    variant: split.agents.memory >= split.yourProcesses.memory ? 'agents' : 'your-terminals'
  }
}

/** Shows at most one notice and returns the delay before the next reading. */
async function evaluate(
  signals: PerfNoticeSignals,
  tracking: Tracking,
  now: number
): Promise<number> {
  if (signals.disk && isDiskAlmostFull(signals) && canShowPerfNotice('disk-almost-full', now)) {
    showPerfNotice({ id: 'disk-almost-full', freeLabel: formatMemory(signals.disk.freeBytes) }, now)
  }
  const fraction = availableFraction(signals)
  // Why: macOS has no in-process available-memory reading yet, so memory notices stay off there.
  if (fraction === null) {
    return CADENCE.healthy
  }
  if (fraction >= LOW_MEMORY_FRACTION) {
    tracking.lowSince = null
  } else {
    tracking.lowSince ??= now
    if (
      now - tracking.lowSince >= LOW_MEMORY_HOLD_MS &&
      now - tracking.ownerShareCheckedAt >= OWNER_SHARE_RECHECK_MS &&
      canShowPerfNotice('memory-low', now)
    ) {
      tracking.ownerShareCheckedAt = now
      const notice = await memoryLowNotice(now)
      if (notice) {
        showPerfNotice(notice, now)
        return CADENCE.tight
      }
    }
  }
  const state = useAppStore.getState()
  // Why: counting idle agents walks agent status, so only do it once memory is tight.
  if (fraction < TIGHT_MEMORY_FRACTION && canShowPerfNotice('idle-agents', now)) {
    const idle = countIdleAgents(state, now)
    if (isIdleAgentsDue(idle, signals)) {
      showPerfNotice({ id: 'idle-agents', idle }, now)
      return CADENCE.tight
    }
  }
  if (isHiddenBrowserTabsDue(state, signals) && canShowPerfNotice('hidden-browser-tabs', now)) {
    showPerfNotice({ id: 'hidden-browser-tabs', count: signals.hiddenBrowserPages }, now)
  }
  return fraction < LOW_MEMORY_FRACTION
    ? CADENCE.low
    : fraction < TIGHT_MEMORY_FRACTION
      ? CADENCE.tight
      : CADENCE.healthy
}

/** Reads run only while this window has focus, slow down when memory is fine, and stop while the user is away. */
function startPerfNoticeLoop(): () => void {
  const tracking: Tracking = { lowSince: null, ownerShareCheckedAt: 0 }
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  let lastKeyAt = 0
  const clear = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
  const schedule = (delayMs: number): void => {
    clear()
    if (!disposed && document.hasFocus()) {
      timer = setTimeout(() => void tick(), delayMs)
    }
  }
  const tick = async (): Promise<void> => {
    timer = null
    const now = Date.now()
    if (now - lastKeyAt < TYPING_QUIET_MS || useAppStore.getState().activeModal !== 'none') {
      schedule(CADENCE.waiting)
      return
    }
    let next: number = CADENCE.healthy
    try {
      const signals = await window.api.memory.readPerfNoticeSignals()
      // Why: with the user away, stop until their next key or click instead of polling.
      if (!signals || signals.userIdleSeconds >= USER_AWAY_SECONDS) {
        return
      }
      next = await evaluate(signals, tracking, now)
    } catch {
      // A failed reading waits for the slow cadence instead of retrying hot.
    }
    schedule(next)
  }
  const onFocus = (): void => {
    if (timer === null) {
      schedule(CADENCE.tight)
    }
  }
  const onKey = (): void => {
    lastKeyAt = Date.now()
    onFocus()
  }
  window.addEventListener('focus', onFocus)
  window.addEventListener('blur', clear)
  window.addEventListener('keydown', onKey, { capture: true, passive: true })
  window.addEventListener('pointerdown', onFocus, { capture: true, passive: true })
  onFocus()
  return () => {
    disposed = true
    clear()
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('blur', clear)
    window.removeEventListener('keydown', onKey, { capture: true })
    window.removeEventListener('pointerdown', onFocus, { capture: true })
  }
}

/** Perf toasts for this machine's memory and disk. */
export function usePerfNotices(): void {
  // Why: a paired web client's terminals run on the host, not on this machine.
  useEffect(() => (isPairedWebClientWindow() ? undefined : startPerfNoticeLoop()), [])
}
