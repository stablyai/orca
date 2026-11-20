import type { ManagedRuntimeInstallObservation } from '@/runtime/hosts/installation/use-managed-runtime-install'
import type { AntigravityAccountState } from '../../../../shared/agent-accounts/antigravity/antigravity-account-types'
import type { AntigravityChatAuthConfig } from '../../../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'

/** What Settings says about the host's Antigravity chats, every one of which runs agy. */
export type AntigravityChatDescription =
  | 'olderHost'
  | 'orcaHome'
  | 'installAgy'
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
  if (method === 'gemini-api-key' || method === 'agent-platform') {
    return 'orcaHome'
  }
  if (install?.source === null) {
    return 'installAgy'
  }
  if (state?.chatAgySignedOut) {
    return 'agySignedOut'
  }
  return install?.source === 'managed' ? 'orcasAgy' : 'agy'
}
