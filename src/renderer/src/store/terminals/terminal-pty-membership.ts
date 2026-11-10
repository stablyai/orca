import type { AppState } from '../types'
import type { TerminalTabRetirementState as State } from './terminal-tab-pty-ownership'
import { createTerminalPtyMembershipOwner } from './terminal-pty-membership-owner'

type Membership = ReturnType<typeof createTerminalPtyMembershipOwner>
const liveOwners = new WeakMap<object, { getState: () => AppState; owner: Membership }>()

export function registerTerminalPtyMembershipStore(store: {
  getState: () => AppState
}): Membership {
  const action = store.getState().closeTab
  let live = liveOwners.get(action)
  if (!live) {
    live = { getState: store.getState, owner: createTerminalPtyMembershipOwner() }
    liveOwners.set(action, live)
  }
  live.owner.accept(store.getState())
  return live.owner
}

export function terminalPtyMembership(state: State): Membership {
  const live =
    'closeTab' in state && typeof state.closeTab === 'function'
      ? liveOwners.get(state.closeTab)
      : undefined
  const owner = live?.getState() === state ? live.owner : createTerminalPtyMembershipOwner()
  owner.accept(state)
  return owner
}
