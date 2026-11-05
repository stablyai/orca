import type { Terminal } from '@xterm/xterm'
import { useAppStore } from '@/store'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import {
  buildWindowsPtyCompatibilityOptions,
  isLocalPtyOwner
} from '@/lib/pane-manager/windows-pty-compatibility'
import {
  remotePtyOwnerMachinePlatform,
  resolveRemotePtyOwnerMachine,
  type PaneOwnerTransport,
  type PtyOwnerMachineState
} from '../pty-owner-machine-platform'

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
 * arrive after mount or bind; until then the pane stays on the Unix model and watches the store,
 * applying the answer once it is known. Switching mid-session is safe: the model only steers resize.
 */
export function createPaneWindowsPtyModel(
  readContext: () => PaneWindowsPtyModelContext,
  store: OwnerMachineStore = useAppStore
): { apply: () => void; dispose: () => void } {
  let unsubscribe: (() => void) | null = null
  const stopWatching = (): void => {
    unsubscribe?.()
    unsubscribe = null
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
  return {
    apply: () => {
      if (applyKnown()) {
        stopWatching()
        return
      }
      unsubscribe ??= store.subscribe(() => {
        if (applyKnown()) {
          stopWatching()
        }
      })
    },
    dispose: stopWatching
  }
}
