import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import { getRemoteRuntimePtyEnvironmentId } from '@/runtime/runtime-terminal-stream'
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import type { PtyTransport } from './pty-transport-types'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'
import type { WorktreeOperationRouteState } from '@/lib/worktree-operation-route'
import { legacyRelayBridgedPane } from './legacy-relay-bridge-panes'

type OwnerTransport = Pick<PtyTransport, 'getPtyId' | 'getRuntimeEnvironmentId' | 'getConnectionId'>

export function resolveTerminalHttpLinkSourceOwner(
  transport: OwnerTransport | null | undefined
): HttpLinkSourceOwner {
  const retainedRuntimeEnvironmentId = transport?.getRuntimeEnvironmentId?.()?.trim()
  if (retainedRuntimeEnvironmentId) {
    return { kind: 'runtime', runtimeEnvironmentId: retainedRuntimeEnvironmentId }
  }

  const ptyId = transport?.getPtyId() ?? null
  const retainedSshConnectionId = transport?.getConnectionId?.()?.trim()
  if (!ptyId) {
    return retainedSshConnectionId
      ? { kind: 'ssh', connectionId: retainedSshConnectionId }
      : { kind: 'local' }
  }

  const runtimeEnvironmentId = getRemoteRuntimePtyEnvironmentId(ptyId)
  if (runtimeEnvironmentId) {
    return { kind: 'runtime', runtimeEnvironmentId }
  }

  const sshPty = parseAppSshPtyId(ptyId)
  if (sshPty) {
    return { kind: 'ssh', connectionId: sshPty.connectionId }
  }

  if (retainedSshConnectionId) {
    return { kind: 'ssh', connectionId: retainedSshConnectionId }
  }

  // Why: legacy remote ids without a retained transport owner are not evidence of local ownership.
  if (parseRemoteRuntimePtyId(ptyId)) {
    return { kind: 'unknown' }
  }
  return { kind: 'local' }
}

/** The pane's terminal handle on its paired server; null for a pane no server runs. */
export function resolveTerminalRuntimeHandle(
  transport: Pick<PtyTransport, 'getPtyId'> | null | undefined
): string | null {
  const ptyId = transport?.getPtyId() ?? null
  return (ptyId ? parseRemoteRuntimePtyId(ptyId)?.handle : null) || null
}

/** The paired server holding the files a pane prints, or `null` for this app's own lookup. */
export function resolveTerminalLinkRuntimeEnvironmentId(
  transport: OwnerTransport | null | undefined,
  state: WorktreeOperationRouteState,
  worktreeId: string
): string | null {
  const owner = resolveTerminalHttpLinkSourceOwner(transport)
  if (owner.kind === 'runtime') {
    return owner.runtimeEnvironmentId
  }
  const ptyId = transport?.getPtyId() ?? null
  // Relay-era panes may lack a server mapping but still print paths on the workspace’s current server, not this computer.
  return ptyId && legacyRelayBridgedPane(ptyId)
    ? runtimeEnvironmentIdUnlessTwin(state, worktreeId)
    : null
}
