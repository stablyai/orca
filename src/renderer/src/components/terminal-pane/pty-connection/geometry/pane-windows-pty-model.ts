import type { Terminal } from '@xterm/xterm'
import { useAppStore } from '@/store/index'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  buildWindowsPtyCompatibilityOptions,
  isLocalPtyOwner
} from '@/lib/pane-manager/terminal-protocol/windows-pty-compatibility'
import {
  remotePtyOwnerMachinePlatform,
  resolveRemotePtyOwnerMachine,
  type PaneOwnerTransport,
  type PtyOwnerMachineState
} from '../../pty-transport/host-ownership/pty-owner-machine-platform'

export type PaneWindowsPtyModelContext = {
  terminal: Pick<Terminal, 'options'>
  owner: {
    executionHostId: ExecutionHostId
    runtimeEnvironmentId: string | null
    connectionId: string | null | undefined
  }
  transport: PaneOwnerTransport
}

type OwnerMachineStore = {
  getState: () => PtyOwnerMachineState
  subscribe: (listener: () => void) => () => void
}

/**
 * Keeps the pane's xterm on the resize model of the machine that owns its PTY, so growing rows
 * never pulls history into a ConPTY grid that repaints from its own view. A remote owner's OS can
 * arrive after mount or bind; until then the pane keeps its model and watches the store, applying
 * the answer once it is known. A paired server's transport can also learn the PTY's own host after
 * bind (a reattached mirror of the server's SSH target), so the pane re-resolves when it does.
 * Switching mid-session is safe: the model only steers resize.
 */
export function createPaneWindowsPtyModel(
  readContext: () => PaneWindowsPtyModelContext,
  store: OwnerMachineStore = useAppStore
): { apply: () => void; dispose: () => void } {
  let unsubscribeStore: (() => void) | null = null
  let transportWatch: { transport: PaneOwnerTransport; unsubscribe: () => void } | null = null
  const stopWatchingStore = (): void => {
    unsubscribeStore?.()
    unsubscribeStore = null
  }
  const stopWatchingTransport = (): void => {
    transportWatch?.unsubscribe()
    transportWatch = null
  }
  const applyKnown = (): boolean => {
    const { terminal, owner, transport } = readContext()
    const isLocal = isLocalPtyOwner(owner)
    const machine = isLocal ? null : resolveRemotePtyOwnerMachine(owner, transport)
    if (!isLocal && !machine) {
      // No owner to name, so no OS will ever arrive: keep the creation-time model.
      return true
    }
    const remoteOwnerPlatform = machine
      ? remotePtyOwnerMachinePlatform(store.getState(), machine)
      : null
    if (machine && remoteOwnerPlatform === null) {
      return false
    }
    const { windowsPty } = buildWindowsPtyCompatibilityOptions({
      userAgent: navigator.userAgent,
      osRelease: window.api.platform?.get?.()?.osRelease,
      connectionId: owner.connectionId,
      executionHostId: owner.executionHostId,
      remoteOwnerPlatform
    })
    terminal.options.windowsPty = windowsPty ?? {}
    return true
  }
  const apply = (): void => {
    const { transport } = readContext()
    // A paired server's transport can re-name the PTY's host on attach (its own SSH target).
    const watched = transport?.getRuntimeEnvironmentId?.() ? transport : null
    if (transportWatch?.transport !== watched) {
      stopWatchingTransport()
      if (watched?.onExecutionHostChange) {
        transportWatch = { transport: watched, unsubscribe: watched.onExecutionHostChange(apply) }
      }
    }
    if (applyKnown()) {
      stopWatchingStore()
      return
    }
    unsubscribeStore ??= store.subscribe(() => {
      if (applyKnown()) {
        stopWatchingStore()
      }
    })
  }
  return {
    apply,
    dispose: () => {
      stopWatchingStore()
      stopWatchingTransport()
    }
  }
}
