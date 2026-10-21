/**
 * How every surface (desktop menus, banners, pickers, mobile) reads a machine: one display state
 * and the actions it allows. Pure and string-typed, so a newer paired server's states are safe.
 * Labels stay with each surface's own translation catalog.
 */

export const MACHINE_DISPLAY_STATES = [
  'starting',
  'running',
  // A sleep or archive the provider accepted but has not finished.
  'stopping',
  'sleeping',
  'archived',
  // The provider reports a fault; unlike lost contact, Delete still reaches it.
  'error',
  'unreachable',
  'gone'
] as const

export type MachineDisplayState = (typeof MACHINE_DISPLAY_STATES)[number]

export type MachineAction = 'wake' | 'sleep' | 'archive' | 'copy-ssh' | 'refresh' | 'delete'

export function getMachineDisplayState(state: string): MachineDisplayState {
  switch (state) {
    case 'creating':
    case 'waking':
      return 'starting'
    case 'running':
    case 'stopping':
    case 'sleeping':
    case 'archived':
    case 'error':
    case 'gone':
      return state
    default:
      // Why: `unknown`, lost contact, and states from a newer provider all need a look, not an action.
      return 'unreachable'
  }
}

/** Opening a worktree on it wakes it first; main runs that wake after a sleep in progress. */
export function machineNeedsWake(state: string): boolean {
  const display = getMachineDisplayState(state)
  return display === 'sleeping' || display === 'archived' || display === 'stopping'
}

const DELETABLE: ReadonlySet<MachineDisplayState> = new Set([
  'running',
  'sleeping',
  'archived',
  'error'
])

/**
 * Only actions that can work right now. A paired server's machines (`local: false`) take Wake and
 * Sleep alone, since create, archive and delete stay with the desktop that runs the provider.
 */
export function getMachineActions(input: {
  state: string
  /** The provider's `capabilities.verbs`; undefined (a snapshot without them) offers nothing verb-backed. */
  verbs: readonly string[] | undefined
  local: boolean
  sshCommandAvailable: boolean
}): MachineAction[] {
  const verbs = new Set(input.verbs ?? [])
  const state = getMachineDisplayState(input.state)
  const actions: MachineAction[] = []
  if ((state === 'sleeping' || state === 'archived') && verbs.has('wake')) {
    actions.push('wake')
  }
  if (state === 'running' && verbs.has('sleep')) {
    actions.push('sleep')
  }
  if (!input.local) {
    return actions
  }
  if ((state === 'running' || state === 'sleeping') && verbs.has('archive')) {
    actions.push('archive')
  }
  if (input.sshCommandAvailable) {
    actions.push('copy-ssh')
  }
  actions.push('refresh')
  // Why: mid-create, mid-wake or mid-sleep the provider is still acting on it; delete once it settles.
  if (DELETABLE.has(state) && verbs.has('delete')) {
    actions.push('delete')
  }
  return actions
}
