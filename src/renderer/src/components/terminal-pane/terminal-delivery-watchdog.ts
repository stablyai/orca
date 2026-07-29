/**
 * Renderer-initiated watchdog for dead main→renderer push delivery.
 *
 * Field evidence (v1.4.121-rc.0 snapshot, 2026-07-06): all `pty:data` push
 * events stop reaching the renderer (a 245-char shell prompt sat un-ACKed;
 * every terminal blank) while invoke IPC keeps working — the wedged window
 * answered `getRendererDeliveryDebugSnapshot` live. The prior recovery layers
 * cannot reach that state: the xterm write-pipeline guards and replay-guard
 * release (#7150) run only after bytes arrive, and the cumulative-ACK +
 * solicited-resync protocol heals lost ACKs but probes over the same push
 * channel that is dead (upstream precedent: electron#37067, one-directional
 * Mojo IPC death). This watchdog is the missing lane: it detects the wedge
 * and heals over invoke — the direction proven alive — with zero cost on the
 * data hot path (one Map upsert per received chunk; a tick does no IPC while
 * output flows or while no PTY delivery is expected).
 */
import { e2eConfig } from '@/lib/e2e-config'
import type { PtyRendererDeliveryHealthReply } from '../../../../shared/pty-renderer-delivery-health'
import { redactPtyIdForDiagnostics } from '../../../../shared/pty-delivery-diagnostics'
import { deliverPulledPtyModelRestoreMarkers } from './pty-model-restore-channel'
import { getProcessedPtyCharTotals } from './terminal-pty-ack-gate'
import { recordTerminalFreezeBreadcrumb } from './terminal-freeze-breadcrumbs'

const WATCHDOG_INTERVAL_MS = 15_000
// Why 2 ticks: one silent interval can be a probe racing an in-transit chunk;
// two full intervals with zero received events while main reports ACK-starved
// in-flight bytes only occurs in the wedged state.
const WATCHDOG_STALL_TICKS_TO_HEAL = 2
// Why: a heal that could not revive the push channel must not repaint-storm;
// pull-restores repeat at most once per cooldown while the wedge persists.
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

/** One Map upsert per received chunk — the watchdog's only hot-path cost.
 *  Counted at dispatcher enqueue, BEFORE parse-deferred ACK crediting, so
 *  main can tell "lost in the channel" from "received, parse-pending". */
export function recordPtyDataReceived(ptyId: string, chars: number): void {
  receivedPtyDataEventCount += 1
  receivedPtyCharTotals.set(ptyId, (receivedPtyCharTotals.get(ptyId) ?? 0) + chars)
}

export function clearReceivedPtyCharTotal(ptyId: string): void {
  receivedPtyCharTotals.delete(ptyId)
}

/** E2e blackhole: simulates the field wedge (push events vanish before the
 *  dispatcher sees them, no receive count, no ACK). Never true in prod. */
export function isPtyPushDeliveryBlackholed(): boolean {
  return blackholePtyPushDelivery
}

function isMainDeliveryStalled(health: PtyRendererDeliveryHealthReply): boolean {
  // Why msSinceLastAck may be null: a wedged-from-first-byte session (the
  // field case's brand-new terminal) never ACKs; in-flight debt alone is the
  // signal then. A recent ACK means some pty still round-trips — not a wedge.
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
  // Why read BEFORE re-attach: 0 here = the listener was detached (app-level
  // bug to hunt); ≥1 = events are being dropped below the emitter (channel
  // dead, platform-level). The single most valuable field discriminator.
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
    // Why serialized: a heal awaits two invokes; overlapping ticks could
    // double-heal inside one cooldown window.
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
  // Why gated on the invoke fn: the web remote client and unit tests expose a
  // partial pty API; without the report lane the watchdog has no safe heal
  // path and must stay off.
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

// ─── E2e control surface ─────────────────────────────────────────────

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
