import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { ManagedRuntimeInstallObservation } from '@/runtime/hosts/installation/use-managed-runtime-install'
import type { AntigravityAccountState } from '../../../../shared/agent-accounts/antigravity/antigravity-account-types'
import type { AntigravityChatAuthConfig } from '../../../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'

/** What Settings says about the host's Antigravity chats, every one of which runs agy. */
export type AntigravityChatDescription =
  | 'olderHost'
  | 'installAgy'
  | 'orcasAgyOff'
  | 'orcaHome'
  | 'agySignedOut'
  | 'orcasAgy'
  | 'agy'

export function antigravityChatDescription(
  state: Pick<AntigravityAccountState, 'chatAgySignedOut'> | null,
  runtime: ManagedRuntimeInstallObservation,
  method: AntigravityChatAuthConfig['method'] | null
): AntigravityChatDescription {
  const install =
    runtime.kind === 'active' && runtime.snapshot.kind === 'known' ? runtime.snapshot.state : null
  // Only hosts that run every chat on agy describe their install as agy's.
  if (install && install.program !== 'cli') {
    return 'olderHost'
  }
  if (install?.source === null) {
    return 'installAgy'
  }
  // A copy Orca isn't keeping current is switched off, and no chat runs it.
  if (install?.source === 'managed' && !install.updatesAutomatically) {
    return 'orcasAgyOff'
  }
  if (method === 'gemini-api-key' || method === 'agent-platform') {
    return 'orcaHome'
  }
  if (state?.chatAgySignedOut) {
    return 'agySignedOut'
  }
  return install?.source === 'managed' ? 'orcasAgy' : 'agy'
}

export function antigravityChatDescriptionText(
  kind: AntigravityChatDescription,
  versions: { managedVersion: string | null; agyVersion?: string | null; t?: Translate }
): string {
  const { managedVersion, agyVersion, t = translate } = versions
  switch (kind) {
    case 'olderHost':
      return t(
        'accounts.antigravity.chatDescriptionOlderHost',
        'Update Orca on this host so its chats run on agy.'
      )
    case 'installAgy':
      return t(
        'accounts.antigravity.chatDescriptionInstallAgy',
        'Install agy below to use Chat. It signs in with its own account.'
      )
    case 'orcasAgyOff':
      return t(
        'accounts.antigravity.chatDescriptionOrcaAgyOff',
        "Orca's agy is switched off here. Install agy yourself to use Chat."
      )
    case 'orcaHome':
      return t(
        'accounts.antigravity.chatDescriptionOrcaHome',
        'Chats run on agy with the key or gcloud login below, apart from agy in the terminal.'
      )
    case 'agySignedOut':
      return t(
        'accounts.antigravity.chatDescriptionAgySignedOut',
        "New chats use agy, which isn't signed in yet. Run agy on this host to sign in."
      )
    case 'orcasAgy':
      return managedVersion
        ? t(
            'accounts.antigravity.chatDescriptionOrcaAgyVersion',
            "Chats run on Orca's agy (v{{version}}) and use agy's own sign-in.",
            { version: managedVersion }
          )
        : t(
            'accounts.antigravity.chatDescriptionOrcaAgy',
            "Chats run on Orca's copy of agy and use agy's own sign-in."
          )
    case 'agy':
      return agyVersion
        ? t(
            'accounts.antigravity.chatDescriptionAgyOwnSignInVersion',
            "Chats run on your agy (v{{version}}) and use agy's own sign-in.",
            { version: agyVersion }
          )
        : t(
            'accounts.antigravity.chatDescriptionAgyOwnSignIn',
            "Chats run on agy and use agy's own sign-in."
          )
  }
}
