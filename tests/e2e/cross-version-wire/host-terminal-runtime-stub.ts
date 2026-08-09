export type HostTerminalDataMeta = {
  seq?: number
  rawLength?: number
  cwd?: string
}

/**
 * The authoritative side of the journey: one terminal handle backed by a fake PTY.
 * It records what the host was actually asked to do (input written, snapshots
 * serialized) so the oracle can prove the journey reached the process, not just
 * that frames moved.
 */
export type HostTerminalRuntimeStub = {
  runtime: unknown
  ptyId: string
  terminalHandle: string
  /** Every text the host wrote to the PTY, in order. */
  writtenInput: string[]
  /** Scrollback the client would see in a snapshot. */
  buffer: string
  /** How many times the host serialized a buffer for a snapshot. */
  serializeCount: number
  /** Push PTY output to every host-side data listener. */
  emitOutput: (data: string, meta?: HostTerminalDataMeta) => void
  /** Names of runtime methods the host called that the stub does not implement. */
  missingRuntimeMethods: string[]
  /** Run the host's registered teardown for one connection, as a socket close does. */
  closeConnection: (connectionId: string) => void
}

export function createHostTerminalRuntimeStub(
  options: {
    terminalHandle?: string
    ptyId?: string
    cols?: number
    rows?: number
    initialBuffer?: string
  } = {}
): HostTerminalRuntimeStub {
  const terminalHandle = options.terminalHandle ?? 'terminal-journey'
  const ptyId = options.ptyId ?? 'pty-journey'
  const cols = options.cols ?? 120
  const rows = options.rows ?? 40
  const dataListeners = new Set<(data: string, meta?: HostTerminalDataMeta) => void>()
  const cleanups = new Map<string, { connectionId: string | undefined; run: () => void }>()
  const stub: HostTerminalRuntimeStub = {
    runtime: null,
    ptyId,
    terminalHandle,
    writtenInput: [],
    buffer: options.initialBuffer ?? '',
    serializeCount: 0,
    emitOutput: () => {},
    missingRuntimeMethods: [],
    closeConnection: () => {}
  }

  stub.closeConnection = (connectionId) => {
    const pending: (() => void)[] = []
    for (const [id, entry] of cleanups) {
      if (entry.connectionId === connectionId) {
        cleanups.delete(id)
        pending.push(entry.run)
      }
    }
    for (const run of pending) {
      run()
    }
  }

  let outputSequence = 0
  stub.emitOutput = (data, meta) => {
    stub.buffer += data
    outputSequence += data.length
    const resolved: HostTerminalDataMeta = {
      seq: outputSequence,
      rawLength: data.length,
      ...meta
    }
    // Snapshot: a listener may unsubscribe while the host fans this out.
    for (const listener of Array.from(dataListeners)) {
      listener(data, resolved)
    }
  }

  const serialize = async (): Promise<{
    data: string
    cols: number
    rows: number
    seq: number
    source: 'headless'
  }> => {
    stub.serializeCount++
    return { data: stub.buffer, cols, rows, seq: outputSequence, source: 'headless' }
  }

  const runtime: Record<string, unknown> = {
    getRuntimeId: () => 'cross-version-host',
    resolveLiveLeafForHandle: (handle: string) => (handle === terminalHandle ? { ptyId } : null),
    resolveLeafForHandle: (handle: string) => (handle === terminalHandle ? { ptyId } : null),
    registerRemoteTerminalViewSubscriber: () => () => {},
    requestRendererTerminalTabMount: () => true,
    updateRemoteDesktopViewer: async () => true,
    unregisterRemoteDesktopViewer: async () => true,
    unregisterRemoteDesktopViewers: async () => true,
    isPtyResizeDrivenRemotely: () => false,
    getRemoteDesktopFitHold: () => ({ mode: 'desktop-fit', cols, rows }),
    isRemoteDesktopViewerOwner: () => false,
    getPtyOutputSequence: () => outputSequence,
    serializeTerminalBuffer: serialize,
    serializeAuthoritativeTerminalBuffer: serialize,
    serializeRendererTerminalBuffer: serialize,
    readTerminal: async () => ({ tail: [], truncated: false }),
    getTerminalSize: () => ({ cols, rows }),
    getMobileDisplayMode: () => 'auto',
    getLayout: () => ({ seq: 1 }),
    getTerminalFitOverride: () => null,
    getDriver: () => ({ kind: 'idle' }),
    subscribeToTerminalData: (
      _ptyId: string,
      listener: (d: string, m?: HostTerminalDataMeta) => void
    ) => {
      dataListeners.add(listener)
      return () => dataListeners.delete(listener)
    },
    subscribeToTerminalResize: () => () => {},
    subscribeToFitOverrideChanges: () => () => {},
    subscribeToDriverChanges: () => () => {},
    registerSubscriptionCleanup: (id: string, cleanup: () => void, connectionId?: string) => {
      cleanups.set(id, { connectionId, run: cleanup })
    },
    cleanupSubscription: (id: string) => {
      const entry = cleanups.get(id)
      cleanups.delete(id)
      entry?.run()
    },
    waitForTerminal: () => new Promise(() => {}),
    // The input oracle: the host reached the process with exactly this text.
    sendTerminal: async (_handle: string, action: { text?: string }) => {
      if (typeof action?.text === 'string') {
        stub.writtenInput.push(action.text)
      }
      return { accepted: true }
    },
    beginMobileInputFloor: () => ({ commit: () => {}, rollback: () => {} }),
    isTerminalInputLocked: () => false,
    getTerminalInputLock: () => null,
    // Source-range accounting is a host-internal ledger, not part of the wire; decline it.
    attachRemoteTerminalSourceRangeConsumer: () => false,
    cancelRemoteTerminalSourceRanges: () => {},
    settleRemoteTerminalSourceRanges: () => {},
    reserveRemoteTerminalSourceRangeReplacement: () => null,
    commitRemoteTerminalSourceRangeReplacement: () => {},
    rollbackRemoteTerminalSourceRangeReplacement: () => {},
    getRendererTerminalSerializerGeneration: () => 0,
    getRendererTerminalSerializerGenerationForHandle: () => 0,
    hasHeadlessTerminalState: () => true,
    isTerminalAlternateScreen: () => false,
    isTerminalRunningAgent: () => false,
    getTerminalAgentStatus: () => null,
    isMobileTerminalQueryReplyAuthority: () => false,
    markMobileActor: () => {},
    refreshRemoteDesktopViewer: async () => true,
    resizeForClient: async () => ({ cols, rows }),
    waitForLeafPtyId: async () => ptyId,
    recoverTerminalPane: async () => null,
    getMobileAutoRestoreFitMs: () => null,
    isMobileSubscriberActive: () => false
  }

  // Why: the two builds may ask the host for different methods. Record the gap by
  // name and return undefined, so the oracle fails naming the method that needs
  // adding here — instead of an unhandled TypeError that reads like a wire break.
  stub.runtime = new Proxy(runtime, {
    get(target, property, receiver) {
      if (typeof property === 'string' && !(property in target)) {
        if (!stub.missingRuntimeMethods.includes(property)) {
          stub.missingRuntimeMethods.push(property)
        }
        return () => undefined
      }
      return Reflect.get(target, property, receiver)
    }
  })

  return stub
}
