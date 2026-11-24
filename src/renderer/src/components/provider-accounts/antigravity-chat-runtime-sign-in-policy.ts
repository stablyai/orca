import type { ManagedRuntimeInstallObservation } from '../../runtime/hosts/installation/use-managed-runtime-install'
import {
  antigravityChatSignInRunning,
  type AntigravityChatSignInView
} from '../../runtime/provider-accounts/sign-in/antigravity-chat-sign-in-status'

const SETTLED_OPERATION_PHASES = new Set(['succeeded', 'failed', 'cancelled'])

type ActiveInstall = Extract<ManagedRuntimeInstallObservation, { kind: 'active' }>

/** Orca's copy is agy, which keeps its own sign-in, so Orca's server sign-in has nothing to run. */
export function antigravityInstallIsAgy(install: ActiveInstall): boolean {
  return install.snapshot.kind === 'known' && install.snapshot.state.program === 'cli'
}

/** Sign-in needs an installed server and no removal; updates keep the old copy usable, while unreported status defers to the host. */
export function antigravityChatSignInBlocked(install: ActiveInstall): boolean {
  const { snapshot } = install
  if (snapshot.kind !== 'known') {
    return snapshot.kind === 'unknown'
  }
  const { source, operation } = snapshot.state
  return (
    antigravityInstallIsAgy(install) ||
    !source ||
    (operation?.kind === 'remove' && !SETTLED_OPERATION_PHASES.has(operation.phase))
  )
}

const CHANGING_PHASES = new Set(['downloading', 'extracting', 'verifying', 'removing'])

/** Require an installed server outside a first install or removal; retain space while host status
 *  is unknown. An update keeps the installed server running, so its sign-in stays shown. */
export function antigravityProviderSignInShown(install: ActiveInstall): boolean {
  const { snapshot } = install
  if (snapshot.kind !== 'known') {
    return true
  }
  const { source, operation, installedVersion } = snapshot.state
  const replacing =
    operation &&
    CHANGING_PHASES.has(operation.phase) &&
    (operation.kind === 'remove' || installedVersion === null)
  return !antigravityInstallIsAgy(install) && source !== null && !replacing
}

/** Orca's own copy runs the chat, so Orca's sign-in applies; the host's agy keeps its own login. */
export function antigravityOrcaRuntimeSignsIn(install: ActiveInstall): boolean {
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

export type AntigravityChatDescription =
  | 'agySignedOut'
  | 'orcasAgy'
  | 'agy'
  | 'installAgy'
  | 'agySignedIn'
  | 'orcaSignIn'

/** What the Chat section says runs new chats here and how they sign in. */
export function antigravityChatDescription(
  chat: { chatUsesAgy?: boolean; chatAgySignedOut?: boolean } | null,
  install: ManagedRuntimeInstallObservation
): AntigravityChatDescription {
  if (chat?.chatAgySignedOut) {
    return 'agySignedOut'
  }
  if (install.kind === 'active' && antigravityInstallIsAgy(install)) {
    const source = install.snapshot.kind === 'known' ? install.snapshot.state.source : null
    return source === 'managed' ? 'orcasAgy' : source === 'external' ? 'agy' : 'installAgy'
  }
  return chat?.chatUsesAgy ? 'agySignedIn' : 'orcaSignIn'
}
