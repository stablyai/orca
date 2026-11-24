import type { ManagedRuntimeInstallObservation } from '../../runtime/hosts/installation/use-managed-runtime-install'
import {
  antigravityChatSignInRunning,
  type AntigravityChatSignInView
} from '../../runtime/provider-accounts/sign-in/antigravity-chat-sign-in-status'

const SETTLED_OPERATION_PHASES = new Set(['succeeded', 'failed', 'cancelled'])

type ActiveInstall = Extract<ManagedRuntimeInstallObservation, { kind: 'active' }>

/** Sign-in runs agy, so it waits for agy to be installed and for any install or removal to end;
 *  an unreadable status defers to the host. */
export function antigravityChatSignInBlocked(install: ActiveInstall): boolean {
  const { snapshot } = install
  if (snapshot.kind !== 'known') {
    return snapshot.kind === 'unknown'
  }
  const { source, operation } = snapshot.state
  return !source || (operation !== null && !SETTLED_OPERATION_PHASES.has(operation.phase))
}

export const isAntigravityGoogleMethod = (method: string | null | undefined): boolean =>
  method === 'oauth-personal' || method === 'oauth-business'

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
