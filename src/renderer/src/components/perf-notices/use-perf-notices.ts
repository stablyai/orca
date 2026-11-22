import { useEffect } from 'react'
import { useAppStore } from '@/store/index'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import {
  isPresenceConfirmed,
  subscribeAutoAckPresenceSignals
} from '@/attention/agent-auto-ack-presence'
import { isResourceManagerOpen } from '../status-bar/resources/resource-manager-open-request'
import {
  isPerfNoticeOff,
  type PerfNoticeId
} from '../../../../shared/perf-notices/perf-notice-settings'
import { canShowPerfNotice } from './perf-notice-ledger'
import { isDiskAlmostFull } from '../../../../shared/diagnostics/perf-notice-signals'
import { HIDDEN_TAB_MIN } from './perf-notice-rules'
import { memorySaverHours, showPerfNotice, type PerfNotice } from './perf-notice-toast'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const READ_INTERVAL_MS = 5 * MINUTE
const QUIET_RETRY_MS = 15_000
const HIDDEN_TABS_RECHECK_MS = 10 * MINUTE
const TYPING_QUIET_MS = 5_000

function mayShow(id: PerfNoticeId, now: number): boolean {
  return !isPerfNoticeOff(useAppStore.getState().settings, id) && canShowPerfNotice(id, now)
}

/** The hidden-tabs notice offers Memory Saver, so it no longer applies once Memory Saver is on. */
function stillApplies(notice: PerfNotice): boolean {
  return (
    notice.id !== 'hidden-browser-tabs' ||
    useAppStore.getState().settings?.browserGuestWorktreeRetentionBudget === false
  )
}

/** Why the loop must hold off; rechecked after every await before anything shows. */
type Gate = () => boolean

async function nextNotice(
  now: number,
  blocked: Gate,
  tracking: { hiddenTabsCheckedAt: number }
): Promise<PerfNotice | null> {
  // Why: a notice that can't show (off, snoozed, capped) never pays for its reading.
  if (mayShow('disk-almost-full', now)) {
    const signals = await window.api.memory.readPerfNoticeSignals()
    if (blocked()) {
      return null
    }
    if (signals?.disk && isDiskAlmostFull(signals.disk)) {
      return { id: 'disk-almost-full' }
    }
  }
  if (
    useAppStore.getState().settings?.browserGuestWorktreeRetentionBudget !== false ||
    now - tracking.hiddenTabsCheckedAt < HIDDEN_TABS_RECHECK_MS ||
    !mayShow('hidden-browser-tabs', now)
  ) {
    return null
  }
  tracking.hiddenTabsCheckedAt = now
  const hours = memorySaverHours()
  const count = await window.api.memory.countHiddenBrowserPages(hours * HOUR)
  return blocked() || count < HIDDEN_TAB_MIN ? null : { id: 'hidden-browser-tabs', count, hours }
}

/** One read at a time, only while this window is focused and the user is present (shared presence
 *  tracker); input or focus restarts it after the user comes back. */
function startPerfNoticeLoop(): () => void {
  const tracking = { hiddenTabsCheckedAt: 0 }
  let timer: ReturnType<typeof setTimeout> | null = null
  let reading = false
  let disposed = false
  let lastKeyAt = 0
  const isQuietTime = (): boolean =>
    Date.now() - lastKeyAt < TYPING_QUIET_MS ||
    useAppStore.getState().activeModal !== 'none' ||
    useAppStore.getState().activeView === 'settings' ||
    isResourceManagerOpen()
  const isIdle = (): boolean => disposed || !document.hasFocus() || !isPresenceConfirmed()
  const blocked: Gate = () => isIdle() || isQuietTime()
  const clear = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
  const schedule = (delayMs: number): void => {
    clear()
    if (!reading && !isIdle()) {
      timer = setTimeout(() => void tick(), delayMs)
    }
  }
  const tick = async (): Promise<void> => {
    timer = null
    if (isIdle()) {
      return
    }
    if (isQuietTime()) {
      schedule(QUIET_RETRY_MS)
      return
    }
    reading = true
    try {
      const notice = await nextNotice(Date.now(), blocked, tracking)
      const shownAt = Date.now()
      // Why: during the read, another window may have shown a toast, or the user changed a setting.
      if (notice && !blocked() && mayShow(notice.id, shownAt) && stillApplies(notice)) {
        showPerfNotice(notice, shownAt)
      }
    } catch {
      // A failed reading waits for the next interval instead of retrying hot.
    } finally {
      reading = false
    }
    schedule(READ_INTERVAL_MS)
  }
  const onActivity = (): void => {
    if (timer === null && !reading) {
      schedule(MINUTE)
    }
  }
  const onKey = (): void => {
    lastKeyAt = Date.now()
  }
  window.addEventListener('blur', clear)
  window.addEventListener('keydown', onKey, { capture: true, passive: true })
  const unsubscribe = subscribeAutoAckPresenceSignals(onActivity, onActivity)
  onActivity()
  return () => {
    disposed = true
    clear()
    unsubscribe()
    window.removeEventListener('blur', clear)
    window.removeEventListener('keydown', onKey, { capture: true })
  }
}

/** Disk and hidden-tab toasts for this machine. */
export function usePerfNotices(): void {
  // Why: a paired web client's disk and tabs live on the host, not on this machine.
  useEffect(() => (isPairedWebClientWindow() ? undefined : startPerfNoticeLoop()), [])
}
