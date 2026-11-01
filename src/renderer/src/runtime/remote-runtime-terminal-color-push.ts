import type { RuntimeHostStatusSnapshot } from '../../../shared/runtime-host-status'
import {
  terminalViewAttributesEqual,
  terminalViewColorQueryReplyColors,
  type TerminalViewAttributes
} from '../../../shared/terminal-view-attributes'
import { callRuntimeRpc } from './runtime-rpc-client'
import { RuntimeRpcCallError } from './runtime-rpc-result'

type PushCall = (environmentId: string, attributes: TerminalViewAttributes) => Promise<unknown>

type ConnectedHost = { runtimeId: string; unsupported: boolean }

export type RemoteRuntimeTerminalColorPush = {
  observeStatusSnapshot: (snapshot: RuntimeHostStatusSnapshot) => void
  setAttributes: (attributes: TerminalViewAttributes) => void
  /** This window gained focus: a headless host with several clients answers with its theme again. */
  pushToAllHosts: () => void
}

function connectedRuntimeId(snapshot: RuntimeHostStatusSnapshot): string | null {
  const live =
    snapshot.verification === 'verified' && snapshot.transport === 'ready' && !snapshot.retired
  return live ? (snapshot.status?.runtimeId ?? null) : null
}

// Unsupported/refused colour pushes cannot succeed on this connection; retry only after reconnect.
function isPermanentRefusal(error: unknown): boolean {
  return (
    error instanceof RuntimeRpcCallError &&
    (error.code === 'method_not_found' || error.code === 'forbidden')
  )
}

/**
 * A headless paired host answers its panes' queries with the theme of the client that pushed
 * last, so this client pushes its appearance to every connected host on connect, change and focus.
 * A host with its own window keeps its own theme and ignores the push for its answers.
 */
export function createRemoteRuntimeTerminalColorPush(
  call: PushCall
): RemoteRuntimeTerminalColorPush {
  const hosts = new Map<string, ConnectedHost>()
  let attributes: TerminalViewAttributes | null = null

  const push = (environmentId: string): void => {
    const host = hosts.get(environmentId)
    if (!attributes || !host || host.unsupported) {
      return
    }
    // Best-effort: a failed push leaves the host answering with the colours it already had.
    call(environmentId, attributes).catch((error: unknown) => {
      if (isPermanentRefusal(error) && hosts.get(environmentId) === host) {
        host.unsupported = true
      }
    })
  }

  const pushToAllHosts = (): void => {
    for (const environmentId of hosts.keys()) {
      push(environmentId)
    }
  }

  return {
    observeStatusSnapshot: (snapshot) => {
      const runtimeId = connectedRuntimeId(snapshot)
      if (!runtimeId) {
        hosts.delete(snapshot.environmentId)
        return
      }
      if (hosts.get(snapshot.environmentId)?.runtimeId === runtimeId) {
        return
      }
      hosts.set(snapshot.environmentId, { runtimeId, unsupported: false })
      push(snapshot.environmentId)
    },
    setAttributes: (next) => {
      if (attributes && terminalViewAttributesEqual(attributes, next)) {
        return
      }
      attributes = next
      pushToAllHosts()
    },
    pushToAllHosts
  }
}

// One lifetime instance joins IPC status with shell-owned colours/focus events.
export const remoteRuntimeTerminalColorPush = createRemoteRuntimeTerminalColorPush(
  (environmentId, attributes) =>
    // Older hosts strip `attributes` and answer from `colors` alone.
    callRuntimeRpc({ kind: 'environment', environmentId }, 'terminal.setViewerColors', {
      colors: terminalViewColorQueryReplyColors(attributes),
      attributes
    })
)
