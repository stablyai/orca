import type { PreloadApi } from '../../../preload/api-types'
import { EMPTY_PTY_MAIN_DELIVERY_DIAGNOSTICS } from '../../../shared/pty-delivery-diagnostics'
import type {
  DesktopPtyDataEvent,
  DesktopPtyExitEvent
} from '../../../shared/desktop-host-protocol'
import type { DesktopHostBridge } from './desktop-host-bridge'

function emptyDeliverySnapshot(): Awaited<
  ReturnType<PreloadApi['pty']['getRendererDeliveryDebugSnapshot']>
> {
  return {
    pendingPtyCount: 0,
    pendingChars: 0,
    maxPendingCharsByPty: 0,
    rendererInFlightPtyCount: 0,
    rendererInFlightChars: 0,
    maxRendererInFlightCharsByPty: 0,
    activeRendererPtyCount: 0,
    flushScheduled: false,
    peakPendingChars: 0,
    peakMaxPendingCharsByPty: 0,
    peakRendererInFlightChars: 0,
    peakMaxRendererInFlightCharsByPty: 0,
    ackGatedFlushSkipCount: 0,
    hiddenDeliveryGatedPtyCount: 0,
    hiddenDeliveryGatedVisiblePtyCount: 0,
    hiddenDeliveryGatedActivePtyCount: 0,
    deliveryInterestPtyCount: 0,
    hiddenDeliveryDroppedChars: 0,
    hiddenDeliveryDroppedChunks: 0,
    pendingDroppedChars: 0,
    diagnostics: EMPTY_PTY_MAIN_DELIVERY_DIAGNOSTICS,
    rendererLifecycleResetCount: 0,
    lastLifecycleResetClearedChars: 0,
    rendererPtyDispatcherReady: false,
    rendererDispatcherReadyForcedCount: 0
  }
}

function noopUnsubscribe(): () => void {
  return () => {}
}

export function createDesktopPtyApi(bridge: DesktopHostBridge): PreloadApi['pty'] {
  return {
    spawn: async (opts) => {
      const result = await bridge.invoke<{ id: string }>('pty:spawn', {
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd,
        env: opts.env,
        command: opts.command
      })
      return { id: result.id }
    },
    write: (id, data) => {
      bridge.send('pty:write', { id, data })
    },
    writeAccepted: (id, data) => bridge.invoke<boolean>('pty:writeAccepted', { id, data }),
    resize: (id, cols, rows) => {
      bridge.send('pty:resize', { id, cols, rows })
    },
    claimViewport: () => {},
    reportGeometry: () => {},
    signal: () => {},
    clearBuffer: () => {},
    kill: async (id) => {
      await bridge.invoke('pty:kill', { id })
    },
    ackColdRestore: () => {},
    ackData: () => {},
    onDeliveryResyncRequest: () => noopUnsubscribe(),
    respondDeliveryResync: () => {},
    reportRendererDeliveryState: async () => ({
      inFlightTotalChars: 0,
      inFlightPtyCount: 0,
      msSinceLastAck: null
    }),
    getPtyDataListenerCount: () => 0,
    rendererDispatcherReady: () => {},
    setActiveRendererPty: () => {},
    setRendererPtyVisible: () => {},
    setHiddenRendererPty: () => {},
    setPtyDeliveryInterest: () => {},
    publishTerminalViewAttributes: () => {},
    hasChildProcesses: (id) => bridge.invoke<boolean>('pty:hasChildProcesses', { id }),
    getForegroundProcess: (id) => bridge.invoke<string | null>('pty:getForegroundProcess', { id }),
    inspectProcess: async (id) => ({
      foregroundProcess: await bridge.invoke<string | null>('pty:getForegroundProcess', { id }),
      hasChildProcesses: await bridge.invoke<boolean>('pty:hasChildProcesses', { id })
    }),
    confirmForegroundProcess: (id) =>
      bridge.invoke<string | null>('pty:getForegroundProcess', { id }),
    getCwd: (id) => bridge.invoke<string>('pty:getCwd', { id }),
    getSize: async () => null,
    listSessions: async () => {
      const sessions = await bridge.invoke<{ id: string; cwd: string }[]>('pty:listSessions')
      return sessions.map((session) => ({
        id: session.id,
        cwd: session.cwd,
        title: '',
        agentOwnership: 'unknown' as const
      }))
    },
    hasPty: async () => null,
    getMainBufferSnapshot: async () => null,
    getRendererDeliveryDebugSnapshot: async () => emptyDeliverySnapshot(),
    resetRendererDeliveryDebug: async () => {},
    onData: (callback) =>
      bridge.on('pty:data', (args) => {
        callback(args as DesktopPtyDataEvent)
      }),
    onReplay: () => noopUnsubscribe(),
    onModelRestoreNeeded: () => noopUnsubscribe(),
    onSideEffect: () => noopUnsubscribe(),
    getSideEffectSnapshot: async () => null,
    onExit: (callback) =>
      bridge.on('pty:exit', (args) => {
        callback(args as DesktopPtyExitEvent)
      }),
    onSpawned: () => noopUnsubscribe(),
    onSerializeBufferRequest: () => noopUnsubscribe(),
    onClearBufferRequest: () => noopUnsubscribe(),
    sendSerializedBuffer: () => {},
    declarePendingPaneSerializer: async () => 0,
    settlePaneSerializer: async () => {},
    clearPendingPaneSerializer: async () => {},
    management: {
      listSessions: async () => ({ sessions: [], degraded: true }),
      killAll: async () => ({ killedCount: 0, remainingCount: 0 }),
      killOne: async () => ({ success: false }),
      restart: async () => ({ success: false }),
      macTccAttribution: async () => ({ health: 'unknown' })
    }
  }
}
