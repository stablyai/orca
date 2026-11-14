import type { ManagedRuntimeInstallObservation } from '../../runtime/hosts/installation/use-managed-runtime-install'
import {
  antigravityChatSignInRunning,
  type AntigravityChatSignInView
} from '../../runtime/provider-accounts/sign-in/antigravity-chat-sign-in-status'

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

/** Orca's own copy runs the chat, so Orca's sign-in applies; the host's agy keeps its own login. */
export function antigravityOrcaRuntimeSignsIn(
  install: Extract<ManagedRuntimeInstallObservation, { kind: 'active' }>
): boolean {
  return (
    install.snapshot.kind === 'known' &&
    install.snapshot.state.source === 'managed' &&
    antigravityProviderSignInShown(install)
  )
}

export type AntigravityChatSignInPrompt = 'signedOut' | 'signingIn' | 'failed'

/** The sign-in step chats still need; null once signed in or while the host hasn't said. */
export function antigravityChatSignInPrompt(
  view: AntigravityChatSignInView
): AntigravityChatSignInPrompt | null {
  if (view.status !== 'known' || view.auth === 'signedIn') {
    return null
  }
  const phase = view.flow?.phase
  if (antigravityChatSignInRunning(view.flow)) {
    return 'signingIn'
  }
  if (view.auth === 'unknown') {
    return null
  }
  return view.error !== null || phase === 'failed' || phase === 'expired' ? 'failed' : 'signedOut'
}
