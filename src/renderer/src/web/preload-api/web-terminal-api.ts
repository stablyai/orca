import type { PreloadApi } from '../../../../preload/api-types'
import { EMPTY_PTY_MAIN_DELIVERY_DIAGNOSTICS } from '../../../../shared/pty-delivery-diagnostics'
import type { SshConnectionState, SshTarget } from '../../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'
import { callRuntimeResult } from './web-runtime-calls'
import { requireActiveEnvironmentOrNull } from './web-runtime-session'
import { noopUnsubscribe } from './web-storage'

export function createPtyApi(): NonNullable<Partial<PreloadApi>['pty']> {
  return {
    spawn: () => Promise.reject(new Error('Local PTYs are unavailable in the web client.')),
    write: () => {},
    writeAccepted: () => Promise.resolve(false),
    resize: () => {},
    claimViewport: () => {},
    reportGeometry: () => {},
    signal: () => {},
    // Web panes clear the host buffer via the terminal.clearBuffer runtime RPC.
    clearBuffer: () => {},
    kill: () => Promise.resolve(),
    ackColdRestore: () => {},
    ackData: () => {},
    onDeliveryResyncRequest: () => noopUnsubscribe,
    respondDeliveryResync: () => {},
    // Why: web terminals bypass main's delivery gate; a zero-in-flight reply keeps the watchdog idle.
    reportRendererDeliveryState: () =>
      Promise.resolve({ inFlightTotalChars: 0, inFlightPtyCount: 0, msSinceLastAck: null }),
    getPtyDataListenerCount: () => 0,
    rendererDispatcherReady: () => {},
    setActiveRendererPty: () => {},
    setRendererPtyVisible: () => {},
    setHiddenRendererPty: () => {},
    setPtyDeliveryInterest: () => {},
    // Why: remote-runtime PTYs are never hidden-gate markable, so there's no main-side responder to feed.
    publishTerminalViewAttributes: () => {},
    hasChildProcesses: () => Promise.resolve(false),
    getForegroundProcess: () => Promise.resolve(null),
    inspectProcess: () => Promise.reject(new Error('terminal_liveness_unavailable')),
    // Why: paired web panes cannot provide a local post-boundary process scan.
    confirmForegroundProcess: () => Promise.resolve(null),
    getCwd: () => Promise.resolve('~'),
    getSize: () => Promise.resolve(null),
    listSessions: () => Promise.resolve([]),
    getAuthoritativeBufferSnapshotCapabilities: (ids) =>
      Promise.resolve(ids.map((id) => ({ id, authoritative: false }))),
    hasPty: () => Promise.resolve(null),
    getMainBufferSnapshot: () => Promise.resolve(null),
    // Why: remote-runtime PTYs skip local main (no side-effect source); renderer byte parsing stays authoritative.
    onSideEffect: () => noopUnsubscribe,
    getSideEffectSnapshot: () => Promise.resolve(null),
    getRendererDeliveryDebugSnapshot: () =>
      Promise.resolve({
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
      }),
    resetRendererDeliveryDebug: () => Promise.resolve(),
    onData: () => noopUnsubscribe,
    onReplay: () => noopUnsubscribe,
    onModelRestoreNeeded: () => noopUnsubscribe,
    onExit: () => noopUnsubscribe,
    onSpawned: () => noopUnsubscribe,
    onSerializeBufferRequest: () => noopUnsubscribe,
    onClearBufferRequest: () => noopUnsubscribe,
    sendSerializedBuffer: () => {},
    declarePendingPaneSerializer: () => Promise.resolve(0),
    settlePaneSerializer: () => Promise.resolve(),
    clearPendingPaneSerializer: () => Promise.resolve(),
    reportRendererSerializerReady: () => Promise.resolve(),
    management: {
      listSessions: () => Promise.resolve({ sessions: [], degraded: false }),
      killAll: () => Promise.resolve({ killedCount: 0, remainingCount: 0, killedSessionIds: [] }),
      killOne: () => Promise.resolve({ success: false }),
      restart: () => Promise.resolve({ success: false }),
      // Why: web clients can't inspect the host daemon's pid record; 'unknown' keeps the banner hidden.
      macTccAttribution: () => Promise.resolve({ health: 'unknown' as const })
    }
  }
}

export function createSshApi(): NonNullable<Partial<PreloadApi>['ssh']> {
  return {
    // Why: SSH is owned by the paired host; route read/connect to runtime RPC for state/reconnect (STA-1468). Target mgmt is desktop-only.
    listTargets: async () => {
      if (!requireActiveEnvironmentOrNull()) {
        return []
      }
      const { targets } = await callRuntimeResult<{ targets: SshTarget[] }>(
        'ssh.listTargetSummaries'
      )
      return targets
    },
    listRemovedTargetLabels: async () => {
      if (!requireActiveEnvironmentOrNull()) {
        return {}
      }
      const { labels } = await callRuntimeResult<{ labels: Record<string, string> }>(
        'ssh.listRemovedTargetLabels'
      )
      return labels
    },
    addTarget: () =>
      Promise.reject(new Error('SSH target management is unavailable in the web client.')),
    updateTarget: () =>
      Promise.reject(new Error('SSH target management is unavailable in the web client.')),
    removeTarget: () => Promise.resolve(),
    importConfig: () => Promise.resolve({ targets: [], repoReadoptions: [] }),
    listConfigHosts: () =>
      Promise.resolve({
        hosts: [],
        totalHostCount: 0,
        newHostCount: 0,
        matchCount: 0,
        hasMore: false
      }),
    resolveConfigHost: () => Promise.resolve(null),
    connect: async (args) => {
      const { state } = await callRuntimeResult<{ state: SshConnectionState | null }>(
        'ssh.connect',
        { targetId: args.targetId }
      )
      return state
    },
    disconnect: () => Promise.resolve(),
    terminateSessions: () => Promise.resolve(),
    resetRelay: () => Promise.resolve(),
    getState: async (args) => {
      if (!requireActiveEnvironmentOrNull()) {
        return null
      }
      const { state } = await callRuntimeResult<{ state: SshConnectionState | null }>(
        'ssh.getState',
        { targetId: args.targetId }
      )
      return state
    },
    needsPassphrasePrompt: () => Promise.resolve(false),
    testConnection: () =>
      Promise.resolve({
        success: false,
        error: translate('auto.web.web.preload.api.31bfe8ae1a', 'Unavailable in the web client.')
      }),
    onStateChanged: () => noopUnsubscribe,
    addPortForward: () =>
      Promise.reject(new Error('SSH port forwarding is unavailable in the web client.')),
    updatePortForward: () =>
      Promise.reject(new Error('SSH port forwarding is unavailable in the web client.')),
    removePortForward: () => Promise.resolve(null),
    listPortForwards: () => Promise.resolve([]),
    listDetectedPorts: () => Promise.resolve([]),
    onPortForwardsChanged: () => noopUnsubscribe,
    onDetectedPortsChanged: () => noopUnsubscribe,
    browseDir: () => Promise.resolve({ entries: [], resolvedPath: '', pathFlavor: 'posix' }),
    onCredentialRequest: () => noopUnsubscribe,
    onCredentialResolved: () => noopUnsubscribe,
    submitCredential: () => Promise.resolve()
  }
}
