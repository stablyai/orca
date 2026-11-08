import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { peekRuntimeEnvironmentCapability } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import { STRUCTURED_CHAT_DISPATCH_TELEMETRY_RUNTIME_CAPABILITY } from '../../../../../../shared/structured-chat-dispatch-telemetry'
import { emitNativeChatMessageSent } from '@/components/native-chat/telemetry/native-chat-telemetry'
import type { AgentType } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { NativeChatStructuredComposerTransport } from './native-chat-structured-composer-transport'

// User admission owns reveal; draft consumption belongs only to draft submission.
export function completeNativeChatStructuredUserAction(
  agent: AgentType,
  transport: NativeChatStructuredComposerTransport,
  reveal: (() => void) | undefined,
  action: 'message' | 'command' | 'continue'
): void {
  const emit = () =>
    emitNativeChatMessageSent({
      agent,
      runtime: transport.runtime,
      action,
      outcome: 'unconfirmed',
      backend: 'structured'
    })
  if (action !== 'message') {
    emit()
  } else if (transport.runtime === 'remote' && transport.runtimeEnvironmentId) {
    const cachedSupport = peekRuntimeEnvironmentCapability(
      transport.runtimeEnvironmentId,
      STRUCTURED_CHAT_DISPATCH_TELEMETRY_RUNTIME_CAPABILITY
    )
    void Promise.resolve(
      cachedSupport ??
        runtimeEnvironmentSupportsCapability(
          transport.runtimeEnvironmentId,
          STRUCTURED_CHAT_DISPATCH_TELEMETRY_RUNTIME_CAPABILITY
        )
    )
      .then((supported) => {
        if (!supported) {
          emit()
        }
      })
      .catch(() => {})
  }
  reveal?.()
}
