import type { ManagedRuntimeInstallObservation } from '../../runtime/hosts/installation/use-managed-runtime-install'

const SETTLED_OPERATION_PHASES = new Set(['succeeded', 'failed', 'cancelled'])

/** Sign-in needs an installed server and no removal; updates keep the old copy usable, while unreported status defers to the host. */
export function antigravityChatSignInBlocked(
  install: Extract<ManagedRuntimeInstallObservation, { kind: 'active' }>
): boolean {
  const { snapshot } = install
  if (snapshot.kind !== 'known') {
    return snapshot.kind === 'unknown'
  }
  const { source, operation } = snapshot.state
  return !source || (operation?.kind === 'remove' && !SETTLED_OPERATION_PHASES.has(operation.phase))
}

const CHANGING_PHASES = new Set(['downloading', 'extracting', 'verifying', 'removing'])

/** Require an installed server outside install/removal; retain space while host status is unknown. */
export function antigravityProviderSignInShown(
  install: Extract<ManagedRuntimeInstallObservation, { kind: 'active' }>
): boolean {
  const { snapshot } = install
  if (snapshot.kind !== 'known') {
    return true
  }
  const { source, operation } = snapshot.state
  return source !== null && !(operation && CHANGING_PHASES.has(operation.phase))
}
