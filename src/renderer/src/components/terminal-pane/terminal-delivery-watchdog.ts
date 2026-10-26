/** Invoke can survive dead main → renderer push delivery; ACK probes use that same dead push channel, so detect and pull-restore through invoke. Skip IPC while output flows or no PTY expects delivery. */
import { e2eConfig } from '@/lib/e2e-config'
import type { PtyRendererDeliveryHealthReply } from '../../../../shared/pty-renderer-delivery-health'
import { redactPtyIdForDiagnostics } from '../../../../shared/pty-delivery-diagnostics'
import { deliverPulledPtyModelRestoreMarkers } from './pty-model-restore-channel'
import { getProcessedPtyCharTotals } from './terminal-pty-ack-gate'
import { recordTerminalFreezeBreadcrumb } from './terminal-freeze-breadcrumbs'

const WATCHDOG_INTERVAL_MS = 15_000
// Two silent ticks distinguish a wedge from one probe racing in-transit output.
const WATCHDOG_STALL_TICKS_TO_HEAL = 2
// Failed push revival must not cause a pull-restore repaint storm; enforce cooldown.
const WATCHDOG_HEAL_COOLDOWN_MS = 60_000

type TerminalDeliveryWatchdogConfig = {
  intervalMs: number
  stallTicksToHeal: number
  healCooldownMs: number
}

type TerminalDeliveryWatchdogDeps = {
  /** Detach and re-subscribe the dispatcher's push-channel listeners. */
  reattachPushListeners: () => void
  /** True while any PTY handler or eager buffer expects push delivery. */
  hasAttachedPtys: () => boolean
}

const receivedPtyCharTotals = new Map<string, number>()
let receivedPtyDataEventCount = 0
let blackholePtyPushDelivery = false

let watchdogDeps: TerminalDeliveryWatchdogDeps | null = null
let watchdogTimer: ReturnType<typeof setInterval> | null = null
let watchdogConfig: TerminalDeliveryWatchdogConfig = {
  intervalMs: WATCHDOG_INTERVAL_MS,
  stallTicksToHeal: WATCHDOG_STALL_TICKS_TO_HEAL,
  healCooldownMs: WATCHDOG_HEAL_COOLDOWN_MS
}
let eventCountAtLastTick = 0
let stallStreakTicks = 0
let lastHealAtMs: number | null = null
let healCount = 0
let tickInFlight = false

/** Count receipt before parse-deferred ACKs so main can distinguish lost delivery from pending parsing; one Map upsert per chunk. */
export function recordPtyDataReceived(ptyId: string, chars: number): void {
  receivedPtyDataEventCount += 1
  receivedPtyCharTotals.set(ptyId, (receivedPtyCharTotals.get(ptyId) ?? 0) + chars)
}

export function clearReceivedPtyCharTotal(ptyId: string): void {
  receivedPtyCharTotals.delete(ptyId)
}

/** E2E blackhole drops push before dispatch receipt/ACK; disabled in production. */
export function isPtyPushDeliveryBlackholed(): boolean {
  return blackholePtyPushDelivery
}

function isMainDeliveryStalled(health: PtyRendererDeliveryHealthReply): boolean {
  // First-byte wedges have no ACK timestamp; use in-flight debt, but reject recent ACKs as evidence of a working channel.
  return (
    health.inFlightTotalChars > 0 &&
    (health.msSinceLastAck === null || health.msSinceLastAck >= watchdogConfig.intervalMs)
  )
}

async function runWatchdogTick(): Promise<void> {
  const deps = watchdogDeps
  const report = window.api?.pty?.reportRendererDeliveryState
  if (!deps || typeof report !== 'function') {
    stopTerminalDeliveryWatchdog()
    return
  }
  if (receivedPtyDataEventCount !== eventCountAtLastTick) {
    eventCountAtLastTick = receivedPtyDataEventCount
    stallStreakTicks = 0
    return
  }
  if (!deps.hasAttachedPtys()) {
    stallStreakTicks = 0
    return
  }
  const health = await report({
    receivedCharsByPty: Object.fromEntries(receivedPtyCharTotals),
    processedCharsByPty: getProcessedPtyCharTotals()
  })
  if (!health || !isMainDeliveryStalled(health)) {
    stallStreakTicks = 0
    return
  }
  stallStreakTicks += 1
  recordTerminalFreezeBreadcrumb('watchdog-stall', {
    stallStreakTicks,
    inFlightTotalChars: health.inFlightTotalChars,
    msSinceLastAck: health.msSinceLastAck
  })
  if (stallStreakTicks < watchdogConfig.stallTicksToHeal) {
    return
  }
  if (lastHealAtMs !== null && Date.now() - lastHealAtMs < watchdogConfig.healCooldownMs) {
    return
  }
  await healDeadPushDelivery(deps, report, health)
}

async function healDeadPushDelivery(
  deps: TerminalDeliveryWatchdogDeps,
  report: NonNullable<Window['api']['pty']['reportRendererDeliveryState']>,
  stalled: PtyRendererDeliveryHealthReply
): Promise<void> {
  lastHealAtMs = Date.now()
  stallStreakTicks = 0
  healCount += 1
  // Read before reattach: zero listeners implicates app detachment; existing listeners implicate delivery below the emitter.
  const listenerCountBeforeReattach = window.api?.pty?.getPtyDataListenerCount?.() ?? null
  deps.reattachPushListeners()
  const healed = await report({
    receivedCharsByPty: Object.fromEntries(receivedPtyCharTotals),
    processedCharsByPty: getProcessedPtyCharTotals(),
    heal: true,
    rendererPtyDataListenerCount: listenerCountBeforeReattach
  })
  const writtenOff = healed?.writtenOff ?? []
  if (writtenOff.length > 0) {
    deliverPulledPtyModelRestoreMarkers(
      writtenOff.map((entry) => ({
        id: entry.id,
        reason: 'delivery-heal' as const,
        ...(typeof entry.markerSeq === 'number' ? { markerSeq: entry.markerSeq } : {})
      }))
    )
  }
  recordTerminalFreezeBreadcrumb('watchdog-heal', {
    listenerCountBeforeReattach,
    writtenOffPtyCount: writtenOff.length,
    writtenOffChars: writtenOff.reduce((sum, entry) => sum + entry.writtenOffChars, 0)
  })
  console.warn('[terminal] delivery watchdog healed dead push delivery', {
    listenerCountBeforeReattach,
    stalledInFlightChars: stalled.inFlightTotalChars,
    stalledPtyCount: stalled.inFlightPtyCount,
    msSinceLastAck: stalled.msSinceLastAck,
    writtenOffPtyCount: writtenOff.length,
    writtenOffChars: writtenOff.reduce((sum, entry) => sum + entry.writtenOffChars, 0),
    healCount
  })
}

function scheduleWatchdogTimer(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer)
  }
  watchdogTimer = setInterval(() => {
    // Serialize ticks across the two invokes to prevent duplicate heals inside one cooldown.
    if (tickInFlight) {
      return
    }
    tickInFlight = true
    void runWatchdogTick().finally(() => {
      tickInFlight = false
    })
  }, watchdogConfig.intervalMs)
}

export function startTerminalDeliveryWatchdog(deps: TerminalDeliveryWatchdogDeps): void {
  if (watchdogDeps) {
    return
  }
  // Partial web/test PTY APIs lack the invoke report lane; without it there is no safe heal path.
  if (typeof window.api?.pty?.reportRendererDeliveryState !== 'function') {
    return
  }
  watchdogDeps = deps
  eventCountAtLastTick = receivedPtyDataEventCount
  scheduleWatchdogTimer()
  exposeE2eTerminalDeliveryWatchdog()
}

export function stopTerminalDeliveryWatchdog(): void {
  watchdogDeps = null
  if (watchdogTimer) {
    clearInterval(watchdogTimer)
    watchdogTimer = null
  }
}

/** Prod-reachable state for the one-paste freeze report (ids redacted). */
export function getTerminalDeliveryWatchdogDiagnostics(): {
  running: boolean
  receivedPtyDataEventCount: number
  receivedCharsByPty: Record<string, number>
  stallStreakTicks: number
  healCount: number
  msSinceLastHeal: number | null
} {
  const receivedCharsByPty: Record<string, number> = {}
  for (const [id, chars] of receivedPtyCharTotals) {
    receivedCharsByPty[redactPtyIdForDiagnostics(id)] = chars
  }
  return {
    running: watchdogTimer !== null,
    receivedPtyDataEventCount,
    receivedCharsByPty,
    stallStreakTicks,
    healCount,
    msSinceLastHeal: lastHealAtMs === null ? null : Date.now() - lastHealAtMs
  }
}

type E2eTerminalDeliveryWatchdogApi = {
  blackhole: (on: boolean) => void
  configure: (config: Partial<TerminalDeliveryWatchdogConfig>) => void
  snapshot: () => {
    receivedPtyDataEventCount: number
    stallStreakTicks: number
    healCount: number
    blackholed: boolean
  }
}

type E2eTerminalDeliveryWatchdogWindow = Window & {
  __terminalDeliveryWatchdog?: E2eTerminalDeliveryWatchdogApi
}

function exposeE2eTerminalDeliveryWatchdog(): void {
  if (!e2eConfig.exposeStore || typeof window === 'undefined') {
    return
  }
  const target = window as E2eTerminalDeliveryWatchdogWindow
  target.__terminalDeliveryWatchdog ??= {
    blackhole: (on) => {
      blackholePtyPushDelivery = on
    },
    configure: (config) => {
      watchdogConfig = { ...watchdogConfig, ...config }
      if (watchdogDeps) {
        scheduleWatchdogTimer()
      }
    },
    snapshot: () => ({
      receivedPtyDataEventCount,
      stallStreakTicks,
      healCount,
      blackholed: blackholePtyPushDelivery
    })
  }
}
