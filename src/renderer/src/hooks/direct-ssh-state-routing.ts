import type { DirectSshAuthority, SshConnectionState } from '../../../shared/ssh-types'
import { directSshAuthoritiesEqual } from './direct-ssh-reconnect-tokens'

export type DirectSshConnectedStateOrigin = 'push' | 'initial-hydration'

export type DirectSshConnectedStateRoutingDeps = {
  coordinator: {
    requestReconnect: (authority: DirectSshAuthority) => Promise<unknown>
    correctUnboundTerminals: (authority: DirectSshAuthority, reason: 'wake-refresh') => number
    replaceAuthority: (authority: DirectSshAuthority) => void
  }
  coordinatorRoutingEnabled: boolean
  invalidateStaleTerminalBindings: (authority: DirectSshAuthority) => number
  retryTargetPanes: (authority: DirectSshAuthority) => number
  prepareAndSync: (
    authority: DirectSshAuthority,
    reason: 'reconnect' | 'initial-hydration' | 'wake-refresh',
    options?: { authorityAlreadyReplaced?: boolean }
  ) => void | Promise<void>
  rememberReconnectAuthority: (authority: DirectSshAuthority | null) => void
}

export type DirectSshConnectedStateRoute =
  | 'initial-hydration'
  | 'changed-authority'
  | 'changed-authority-fallback'
  | 'same-authority-wake'

export function routeDirectSshConnectedState(
  deps: DirectSshConnectedStateRoutingDeps,
  input: {
    authority: DirectSshAuthority
    previousAuthority: DirectSshAuthority | null
    origin: DirectSshConnectedStateOrigin
  }
): DirectSshConnectedStateRoute {
  const { authority } = input
  if (input.origin === 'initial-hydration') {
    deps.rememberReconnectAuthority(null)
    void deps.prepareAndSync(authority, 'initial-hydration')
    return 'initial-hydration'
  }
  if (!directSshAuthoritiesEqual(input.previousAuthority, authority)) {
    deps.rememberReconnectAuthority(authority)
    if (deps.coordinatorRoutingEnabled) {
      void deps.coordinator.requestReconnect(authority)
      return 'changed-authority'
    }
    deps.coordinator.replaceAuthority(authority)
    deps.invalidateStaleTerminalBindings(authority)
    deps.retryTargetPanes(authority)
    void deps.prepareAndSync(authority, 'reconnect', { authorityAlreadyReplaced: true })
    return 'changed-authority-fallback'
  }
  deps.coordinator.correctUnboundTerminals(authority, 'wake-refresh')
  void deps.prepareAndSync(authority, 'wake-refresh')
  return 'same-authority-wake'
}

export function directSshAuthorityFromConnectionState(
  targetId: string,
  state: SshConnectionState
): DirectSshAuthority | null {
  if (
    state.targetId !== targetId ||
    state.status !== 'connected' ||
    !state.providerEpoch ||
    state.connectionGeneration === undefined
  ) {
    return null
  }
  return {
    targetId,
    providerEpoch: state.providerEpoch,
    connectionGeneration: state.connectionGeneration
  }
}

export function registerDirectSshWakeRouting(deps: {
  getConnectionStates: () => Iterable<readonly [string, SshConnectionState]>
  wakeAuthority: (authority: DirectSshAuthority) => void
  onSystemResumed?: (callback: () => void) => () => void
}): () => void {
  let stopped = false
  const wake = (): void => {
    if (stopped) {
      return
    }
    for (const [targetId, state] of deps.getConnectionStates()) {
      const authority = directSshAuthorityFromConnectionState(targetId, state)
      if (authority) {
        deps.wakeAuthority(authority)
      }
    }
  }
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('online', wake)
  }
  const unsubscribeSystemResumed = deps.onSystemResumed?.(wake)
  return () => {
    if (stopped) {
      return
    }
    stopped = true
    if (typeof window.removeEventListener === 'function') {
      window.removeEventListener('online', wake)
    }
    unsubscribeSystemResumed?.()
  }
}
