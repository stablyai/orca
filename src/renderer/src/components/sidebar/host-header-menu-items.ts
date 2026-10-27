import type { ExecutionHostKind } from '../../../../shared/execution-host'
import type { ExecutionHostHealth } from '../../../../shared/execution-host-registry'
import type { RuntimeCompatVerdict } from '../../../../shared/protocol-compat'
import type { RuntimeHostBlockedReason } from '../../../../shared/runtime-host-status'

// Host scoping belongs to the scope strip; this menu manages lifecycle and section collapse.
export type HostHeaderMenuAction =
  | 'runtime-repair'
  | 'rename'
  | 'manage'
  | 'ssh-reconnect'
  | 'ssh-disconnect'
  | 'runtime-check-connection'
  | 'remove'

export type HostHeaderMenuModel = {
  actions: HostHeaderMenuAction[]
  blocked: {
    reason: 'client-too-old' | 'server-too-old'
  } | null
}

export type HostHeaderMenuInput = {
  kind: ExecutionHostKind
  health: ExecutionHostHealth
  /** SSH connection status drives Reconnect vs Disconnect. */
  sshConnected?: boolean
  compatibility?: RuntimeCompatVerdict
  blockedReason?: RuntimeHostBlockedReason
  /** False for a server Orca pairs itself (over SSH), whose repair is Connect, not an access link. */
  repairableWithAccessLink?: boolean
}

function sshActions(connected: boolean): HostHeaderMenuAction[] {
  return connected ? ['ssh-disconnect'] : ['ssh-reconnect']
}

export function buildHostHeaderMenuModel(input: HostHeaderMenuInput): HostHeaderMenuModel {
  const actions: HostHeaderMenuAction[] = []
  // Why first: a revoked pairing is the one fix the user came to the menu for.
  if (
    input.kind === 'runtime' &&
    input.health === 'blocked' &&
    input.blockedReason === 'access-revoked' &&
    input.repairableWithAccessLink !== false
  ) {
    actions.push('runtime-repair')
  }
  actions.push('rename')

  switch (input.kind) {
    case 'ssh':
      actions.push(...sshActions(input.sshConnected ?? false))
      break
    case 'runtime':
      actions.push('runtime-check-connection')
      break
    case 'local':
      break
  }

  actions.push('manage')

  if (input.kind === 'ssh' || input.kind === 'runtime') {
    actions.push('remove')
  }

  const blocked =
    input.health === 'blocked' &&
    input.blockedReason !== 'access-revoked' &&
    input.compatibility?.kind === 'blocked'
      ? { reason: input.compatibility.reason }
      : null

  return { actions, blocked }
}
