import { useEffect } from 'react'
import { useAppStore } from '@/store/index'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import type { PerfNoticeSignals } from '../../../../shared/diagnostics/perf-notice-signals'
import { formatMemory } from '../status-bar/resources/popover/resource-usage-metrics'
import {
  readAgentPaneKeys,
  splitSnapshotByOwner
} from '../status-bar/resources/popover/resource-owner-split'
import {
  hasResourceManager,
  isResourceManagerOpen
} from '../status-bar/resources/resource-manager-open-request'
import { canShowPerfNotice } from './perf-notice-ledger'
import {
  availableFraction,
  countIdleAgents,
  hasTerminalCandidates,
  HIDDEN_TAB_MIN,
  IDLE_AGENT_MIN,
  idleAgentCandidates,
  isDiskAlmostFull,
  liveLocalTerminals,
  LOW_MEMORY_FRACTION,
  PERF_NOTICE_OFFERS_AGENT_SLEEP,
  TERMINAL_SHARE_MIN,
  TIGHT_MEMORY_FRACTION
} from './perf-notice-rules'
import { memorySaverHours, showPerfNotice, type PerfNotice } from './perf-notice-toast'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const LOW_MEMORY_HOLD_MS = 2 * MINUTE
// Why: each owner check takes a full process snapshot, so a failed one waits hours, not minutes.
const OWNER_SHARE_RECHECK_MS = 6 * HOUR
// Why: proving idle terminal agents takes a process snapshot, so a check without a toast waits an hour.
const IDLE_AGENT_RECHECK_MS = HOUR
const HIDDEN_TABS_RECHECK_MS = 10 * MINUTE
const AGENT_SLEEP_IDLE_MS = 30 * MINUTE
const TYPING_QUIET_MS = 5_000
const USER_AWAY_MS = 5 * MINUTE

const CADENCE = {
  low: 30_000,
  tight: MINUTE,
  healthy: 5 * MINUTE,
  waiting: 15_000
} as const

type Tracking = {
  lowSince: number | null
  ownerShareCheckedAt: number
  idleCheckedAt: number
  hiddenTabsCheckedAt: number
}

/** Why the loop must hold off right now; rechecked after every await before anything shows. */
type Gate = () => boolean
/** Wall-clock ms at which the user counts as away, so main starts no process sweep after it. */
type ActiveUntil = () => number

/** Memory-low names terminals only when they hold most of the used memory; never Orca, never other apps. */
async function memoryLowNotice(
  now: number,
  blocked: Gate,
  activeUntil: ActiveUntil
): Promise<PerfNotice | null> {
  // Why: every variant can open Resources, so skip the process snapshot when it can't.
  if (!hasResourceManager()) {
    return null
  }
  const snapshot = await window.api.memory.getSnapshot({
    whileFocused: true,
    activeUntil: activeUntil()
  })
  if (blocked()) {
    return null
  }
  const state = useAppStore.getState()
  // Why: no daemon listing, so it starts no RPC; unkeyed samples land in Your processes, so only
  // fully keyed samples may name Your terminals.
  const split = splitSnapshotByOwner(snapshot, [], readAgentPaneKeys())
  const allKeyed = snapshot.worktrees.every((worktree) =>
    worktree.sessions.every((session) => session.paneKey != null)
  )
  const used = snapshot.host.usedMemory
  const terminals = split.agents.memory + split.yourProcesses.memory
  if (used <= 0 || terminals / used < TERMINAL_SHARE_MIN) {
    return null
  }
  if (
    PERF_NOTICE_OFFERS_AGENT_SLEEP &&
    !state.settings?.experimentalAgentHibernation &&
    countIdleAgents(
      state,
      idleAgentCandidates(state, now, AGENT_SLEEP_IDLE_MS),
      liveLocalTerminals(snapshot)
    ).terminal > 0
  ) {
    return { id: 'memory-low', variant: 'agent-sleep' }
  }
  return {
    id: 'memory-low',
    variant:
      split.agents.memory / used >= TERMINAL_SHARE_MIN
        ? 'agents'
        : allKeyed && split.yourProcesses.memory / used >= TERMINAL_SHARE_MIN
          ? 'your-terminals'
          : 'terminals'
  }
}

async function idleAgentsNotice(
  now: number,
  blocked: Gate,
  activeUntil: ActiveUntil,
  tracking: Tracking
): Promise<PerfNotice | null> {
  const candidates = idleAgentCandidates(useAppStore.getState(), now)
  if (candidates.length < IDLE_AGENT_MIN) {
    return null
  }
  tracking.idleCheckedAt = now
  // Why: only terminal agents need the snapshot's proof that their process is alive.
  const live = hasTerminalCandidates(candidates)
    ? liveLocalTerminals(
        await window.api.memory.getSnapshot({ whileFocused: true, activeUntil: activeUntil() })
      )
    : null
  if (blocked()) {
    return null
  }
  // Why: agents may have started working during the snapshot; only rows still idle count.
  const state = useAppStore.getState()
  const idle = countIdleAgents(state, idleAgentCandidates(state, Date.now()), live)
  if (idle.terminal + idle.chats < IDLE_AGENT_MIN) {
    return null
  }
  // Why: terminal-only idle points at Resources, which must exist to open.
  return idle.chats === 0 && !hasResourceManager() ? null : { id: 'idle-agents', idle }
}

async function hiddenTabsNotice(blocked: Gate): Promise<PerfNotice | null> {
  const hours = memorySaverHours()
  const count = await window.api.memory.countHiddenBrowserPages(hours * HOUR)
  return blocked() || count < HIDDEN_TAB_MIN ? null : { id: 'hidden-browser-tabs', count, hours }
}

/** Shows at most one notice and returns the delay before the next reading. */
async function evaluate(
  signals: PerfNoticeSignals,
  tracking: Tracking,
  now: number,
  blocked: Gate,
  activeUntil: ActiveUntil
): Promise<number> {
  if (signals.disk && isDiskAlmostFull(signals) && canShowPerfNotice('disk-almost-full', now)) {
    showPerfNotice({ id: 'disk-almost-full', freeLabel: formatMemory(signals.disk.freeBytes) }, now)
    return CADENCE.healthy
  }
  const fraction = availableFraction(signals)
  // Why: macOS has no in-process available-memory reading yet, so memory notices stay off there.
  if (fraction === null || fraction >= TIGHT_MEMORY_FRACTION) {
    tracking.lowSince = null
    return CADENCE.healthy
  }
  let notice: PerfNotice | null = null
  if (fraction >= LOW_MEMORY_FRACTION) {
    tracking.lowSince = null
  } else {
    tracking.lowSince ??= now
    // Why: while the low reading is held, nothing else may spend the daily cap before memory-low can.
    if (now - tracking.lowSince < LOW_MEMORY_HOLD_MS) {
      return CADENCE.low
    }
    if (
      now - tracking.ownerShareCheckedAt >= OWNER_SHARE_RECHECK_MS &&
      canShowPerfNotice('memory-low', now)
    ) {
      tracking.ownerShareCheckedAt = now
      notice = await memoryLowNotice(now, blocked, activeUntil)
    }
  }
  // Why: a blocked step admits no further work; the next tick starts over.
  if (blocked()) {
    return CADENCE.tight
  }
  if (
    !notice &&
    now - tracking.idleCheckedAt >= IDLE_AGENT_RECHECK_MS &&
    canShowPerfNotice('idle-agents', now)
  ) {
    notice = await idleAgentsNotice(now, blocked, activeUntil, tracking)
  }
  if (blocked()) {
    return CADENCE.tight
  }
  if (
    !notice &&
    useAppStore.getState().settings?.browserGuestWorktreeRetentionBudget === false &&
    now - tracking.hiddenTabsCheckedAt >= HIDDEN_TABS_RECHECK_MS &&
    canShowPerfNotice('hidden-browser-tabs', now)
  ) {
    tracking.hiddenTabsCheckedAt = now
    notice = await hiddenTabsNotice(blocked)
  }
  if (notice && !blocked()) {
    showPerfNotice(notice, now)
  }
  return fraction < LOW_MEMORY_FRACTION ? CADENCE.low : CADENCE.tight
}

/** Reads run only while this window has focus, one at a time, slow down when memory is fine, and
 *  stop once the user has been away 5 minutes until their next key or click. */
function startPerfNoticeLoop(): () => void {
  const tracking: Tracking = {
    lowSince: null,
    ownerShareCheckedAt: 0,
    idleCheckedAt: 0,
    hiddenTabsCheckedAt: 0
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  let reading = false
  let disposed = false
  let lastKeyAt = 0
  let lastActivityAt = Date.now()
  const isQuietTime = (): boolean =>
    Date.now() - lastKeyAt < TYPING_QUIET_MS ||
    useAppStore.getState().activeModal !== 'none' ||
    useAppStore.getState().activeView === 'settings' ||
    isResourceManagerOpen()
  const isAway = (): boolean => Date.now() - lastActivityAt >= USER_AWAY_MS
  const activeUntil: ActiveUntil = () => lastActivityAt + USER_AWAY_MS
  const blocked: Gate = () => disposed || !document.hasFocus() || isQuietTime() || isAway()
  const clear = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
  const schedule = (delayMs: number): void => {
    clear()
    // Why: away, nothing is armed; the next key or click restarts the loop.
    if (!disposed && !reading && document.hasFocus() && !isAway()) {
      timer = setTimeout(() => void tick(), delayMs)
    }
  }
  const tick = async (): Promise<void> => {
    timer = null
    const now = Date.now()
    if (isAway()) {
      return
    }
    if (isQuietTime()) {
      schedule(CADENCE.waiting)
      return
    }
    reading = true
    let next: number | null = CADENCE.healthy
    try {
      const signals = await window.api.memory.readPerfNoticeSignals()
      if (!signals || signals.userIdleSeconds * 1000 >= USER_AWAY_MS) {
        next = null
      } else if (!blocked()) {
        next = await evaluate(signals, tracking, now, blocked, activeUntil)
      }
    } catch {
      // A failed reading waits for the slow cadence instead of retrying hot.
    } finally {
      reading = false
    }
    if (next !== null) {
      schedule(next)
    }
  }
  const onActivity = (): void => {
    lastActivityAt = Date.now()
    if (timer === null && !reading) {
      schedule(CADENCE.tight)
    }
  }
  const onKey = (): void => {
    lastKeyAt = Date.now()
    onActivity()
  }
  window.addEventListener('focus', onActivity)
  window.addEventListener('blur', clear)
  window.addEventListener('keydown', onKey, { capture: true, passive: true })
  window.addEventListener('pointerdown', onActivity, { capture: true, passive: true })
  onActivity()
  return () => {
    disposed = true
    clear()
    window.removeEventListener('focus', onActivity)
    window.removeEventListener('blur', clear)
    window.removeEventListener('keydown', onKey, { capture: true })
    window.removeEventListener('pointerdown', onActivity, { capture: true })
  }
}

/** Perf toasts for this machine's memory and disk. */
export function usePerfNotices(): void {
  // Why: a paired web client's terminals run on the host, not on this machine.
  useEffect(() => (isPairedWebClientWindow() ? undefined : startPerfNoticeLoop()), [])
}
