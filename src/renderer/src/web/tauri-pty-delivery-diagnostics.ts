import type {
  PtyMainDeliveryDiagnostics,
  PtyPerPtyDeliveryDiagnostics
} from '../../../shared/terminal/pty/diagnostics/pty-delivery-diagnostics'
import type {
  PtyRendererDeliveryHealthReply,
  PtyRendererDeliveryStateReport
} from '../../../shared/terminal/pty/diagnostics/pty-renderer-delivery-health'
import { EMPTY_PTY_MAIN_DELIVERY_DIAGNOSTICS } from '../../../shared/terminal/pty/diagnostics/pty-delivery-diagnostics'

type TauriPtyDeliveryState = {
  sentChars: number
  ackedChars: number
  receivedChars: number
  lastSendAt: number | null
  lastAckAt: number | null
  hidden: boolean
  visible: boolean
  active: boolean
  interested: boolean
}

type TauriPtyDeliveryDebugSnapshot = {
  pendingPtyCount: number
  pendingChars: number
  maxPendingCharsByPty: number
  rendererInFlightPtyCount: number
  rendererInFlightChars: number
  maxRendererInFlightCharsByPty: number
  activeRendererPtyCount: number
  flushScheduled: boolean
  peakPendingChars: number
  peakMaxPendingCharsByPty: number
  peakRendererInFlightChars: number
  peakMaxRendererInFlightCharsByPty: number
  ackGatedFlushSkipCount: number
  hiddenDeliveryGatedPtyCount: number
  hiddenDeliveryGatedVisiblePtyCount: number
  hiddenDeliveryGatedActivePtyCount: number
  deliveryInterestPtyCount: number
  hiddenDeliveryDroppedChars: number
  hiddenDeliveryDroppedChunks: number
  pendingDroppedChars: number
  diagnostics: PtyMainDeliveryDiagnostics
  rendererLifecycleResetCount: number
  lastLifecycleResetClearedChars: number
  rendererPtyDispatcherReady: boolean
  rendererDispatcherReadyForcedCount: number
}

function createState(): TauriPtyDeliveryState {
  return {
    sentChars: 0,
    ackedChars: 0,
    receivedChars: 0,
    lastSendAt: null,
    lastAckAt: null,
    hidden: false,
    visible: true,
    active: false,
    interested: false
  }
}

function inFlightChars(state: TauriPtyDeliveryState): number {
  return Math.max(0, state.sentChars - state.ackedChars)
}

function nowMs(): number {
  return Date.now()
}

/** Renderer-side accounting used when Tauri bypasses Electron's push-credit IPC. */
export function createTauriPtyDeliveryDiagnostics() {
  const states = new Map<string, TauriPtyDeliveryState>()
  let dispatcherReady = false
  let peakRendererInFlightChars = 0
  let peakMaxRendererInFlightCharsByPty = 0

  const stateFor = (id: string): TauriPtyDeliveryState => {
    const existing = states.get(id)
    if (existing) {
      return existing
    }
    const created = createState()
    states.set(id, created)
    return created
  }

  const recordData = (id: string, chars: number): void => {
    const state = stateFor(id)
    const at = nowMs()
    state.sentChars += Math.max(0, chars)
    state.receivedChars += Math.max(0, chars)
    state.lastSendAt = at
    const totalInFlight = totalInFlightChars()
    peakRendererInFlightChars = Math.max(peakRendererInFlightChars, totalInFlight)
    peakMaxRendererInFlightCharsByPty = Math.max(
      peakMaxRendererInFlightCharsByPty,
      inFlightChars(state)
    )
  }

  const recordAck = (id: string, chars: number, processedChars?: number): void => {
    const state = stateFor(id)
    state.ackedChars =
      typeof processedChars === 'number' && Number.isFinite(processedChars)
        ? Math.max(state.ackedChars, Math.max(0, processedChars))
        : Math.min(state.sentChars, state.ackedChars + Math.max(0, chars))
    state.lastAckAt = nowMs()
  }

  const totalInFlightChars = (): number => {
    let total = 0
    for (const state of states.values()) {
      total += inFlightChars(state)
    }
    return total
  }

  const diagnosticsFor = (
    id: string,
    state: TauriPtyDeliveryState
  ): PtyPerPtyDeliveryDiagnostics => {
    const at = nowMs()
    return {
      id,
      sentChars: state.sentChars,
      ackedChars: state.ackedChars,
      inFlightChars: inFlightChars(state),
      pendingChars: Math.max(0, state.receivedChars - state.ackedChars),
      hidden: state.hidden,
      visible: state.visible,
      active: state.active,
      msSinceLastSend: state.lastSendAt === null ? null : Math.max(0, at - state.lastSendAt),
      msSinceLastAck: state.lastAckAt === null ? null : Math.max(0, at - state.lastAckAt)
    }
  }

  const snapshotDiagnostics = (): PtyMainDeliveryDiagnostics => ({
    ...EMPTY_PTY_MAIN_DELIVERY_DIAGNOSTICS,
    mainUptimeMs: 0,
    perPty: Array.from(states, ([id, state]) => diagnosticsFor(id, state))
  })

  return {
    recordData,
    recordAck,
    remove: (id: string): void => {
      states.delete(id)
    },
    setDispatcherReady: (ready: boolean): void => {
      dispatcherReady = ready
    },
    setActive: (id: string, active: boolean): void => {
      stateFor(id).active = active
    },
    setVisible: (id: string, visible: boolean): void => {
      stateFor(id).visible = visible
    },
    setHidden: (id: string, hidden: boolean): void => {
      stateFor(id).hidden = hidden
    },
    setInterested: (id: string, interested: boolean): void => {
      stateFor(id).interested = interested
    },
    report: (_report: PtyRendererDeliveryStateReport): PtyRendererDeliveryHealthReply => {
      const lastAckAt = Array.from(states.values())
        .map((state) => state.lastAckAt)
        .filter((value): value is number => value !== null)
        .sort((left, right) => right - left)[0]
      return {
        inFlightTotalChars: totalInFlightChars(),
        inFlightPtyCount: Array.from(states.values()).filter((state) => inFlightChars(state) > 0)
          .length,
        msSinceLastAck: lastAckAt === undefined ? null : Math.max(0, nowMs() - lastAckAt)
      }
    },
    snapshot: (): TauriPtyDeliveryDebugSnapshot => {
      const perPty = Array.from(states.values())
      const pending = perPty.map((state) => Math.max(0, state.receivedChars - state.ackedChars))
      const inFlight = perPty.map(inFlightChars)
      return {
        pendingPtyCount: pending.filter((value) => value > 0).length,
        pendingChars: pending.reduce((sum, value) => sum + value, 0),
        maxPendingCharsByPty: Math.max(0, ...pending),
        rendererInFlightPtyCount: inFlight.filter((value) => value > 0).length,
        rendererInFlightChars: inFlight.reduce((sum, value) => sum + value, 0),
        maxRendererInFlightCharsByPty: Math.max(0, ...inFlight),
        activeRendererPtyCount: perPty.filter((state) => state.active).length,
        flushScheduled: false,
        peakPendingChars: 0,
        peakMaxPendingCharsByPty: 0,
        peakRendererInFlightChars,
        peakMaxRendererInFlightCharsByPty,
        ackGatedFlushSkipCount: 0,
        hiddenDeliveryGatedPtyCount: perPty.filter((state) => state.hidden).length,
        hiddenDeliveryGatedVisiblePtyCount: perPty.filter((state) => state.hidden && state.visible)
          .length,
        hiddenDeliveryGatedActivePtyCount: perPty.filter((state) => state.hidden && state.active)
          .length,
        deliveryInterestPtyCount: perPty.filter((state) => state.interested).length,
        hiddenDeliveryDroppedChars: 0,
        hiddenDeliveryDroppedChunks: 0,
        pendingDroppedChars: 0,
        diagnostics: snapshotDiagnostics(),
        rendererLifecycleResetCount: 0,
        lastLifecycleResetClearedChars: 0,
        rendererPtyDispatcherReady: dispatcherReady,
        rendererDispatcherReadyForcedCount: 0
      }
    },
    reset: (): void => {
      states.clear()
      peakRendererInFlightChars = 0
      peakMaxRendererInFlightCharsByPty = 0
      dispatcherReady = false
    }
  }
}
