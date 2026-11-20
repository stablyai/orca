import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import { ANTIGRAVITY_AGY_CHATS_RUNTIME_CAPABILITY } from '../../../../shared/remote-runtime/protocol/account-runtime-capabilities'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'

/** A host that doesn't say its chats all run agy may still run Orca's old server, whose sign-in
 *  this client can neither show nor change. A host not heard from yet counts as current. */
export function useOlderAntigravityHost(host: RuntimeClientTarget | null): boolean {
  return (
    useStructuredAgentSessionHostCapabilityState(host, ANTIGRAVITY_AGY_CHATS_RUNTIME_CAPABILITY) ===
    'unsupported'
  )
}
