import type { ExecutionHostKind } from '../../../../shared/execution-host'
import type { ExecutionHostHealth } from '../../../../shared/execution-host-registry'
import type { RuntimeCompatVerdict } from '../../../../shared/protocol-compat'

// Why: the host-header dropdown shows different lifecycle actions per host kind.
// Keeping the availability rules in a pure function makes them unit-testable
// without rendering the sidebar.
// Why: no 'focus' action here — the host scope strip is the single scoping
// control (the design doc forbids a separate focused-host toggle), and
// decluttering is served by collapsing the section.
export type HostHeaderMenuAction =
  | 'rename'
  | 'manage'
  | 'ssh-reconnect'
  | 'ssh-disconnect'
  | 'runtime-check-connection'
  | 'remove'

export type HostHeaderMenuModel = {
  /** Lifecycle/navigation actions, in display order. */
  actions: HostHeaderMenuAction[]
  /** Present only when the host is blocked on a compatibility verdict. */
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
}

function sshActions(connected: boolean): HostHeaderMenuAction[] {
  // Why: only offer the action that changes state — Disconnect when up,
  // Reconnect otherwise — to avoid a dead menu item.
  return connected ? ['ssh-disconnect'] : ['ssh-reconnect']
}

export function buildHostHeaderMenuModel(input: HostHeaderMenuInput): HostHeaderMenuModel {
  // Why: Rename edits only the client-side display label, so it's offered for
  // every host kind including local.
  const actions: HostHeaderMenuAction[] = ['rename']

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

  // Manage host… always closes out the list as the catch-all deep link.
  actions.push('manage')

  // Why: removing a host deletes the underlying SSH target / runtime
  // environment, which only exists for those kinds — local can't be removed.
  if (input.kind === 'ssh' || input.kind === 'runtime') {
    actions.push('remove')
  }

  const blocked =
    input.health === 'blocked' && input.compatibility?.kind === 'blocked'
      ? { reason: input.compatibility.reason }
      : null

  return { actions, blocked }
}
