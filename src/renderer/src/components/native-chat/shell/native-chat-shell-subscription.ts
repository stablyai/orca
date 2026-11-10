import { translate } from '@/i18n/i18n'
import { subscribeRuntimeRpc } from '@/runtime/rpc/subscriptions/runtime-rpc-subscribe'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { AGENT_SESSION_SHELL_COMMAND_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/agent-session-runtime-capabilities'
import type { AgentSessionShellCommandFrame } from '../../../../../shared/rpc-contract/structured-agent-session-shell-command-params'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'

export type NativeChatShellSink = {
  frame: (frame: AgentSessionShellCommandFrame) => void
  fail: (error: unknown) => void
}

function isShellFrame(value: unknown): value is AgentSessionShellCommandFrame {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    (value.type === 'started' || value.type === 'output' || value.type === 'exit')
  )
}

export function subscribeNativeChatShellCommand(
  target: RuntimeClientTarget,
  sessionId: string,
  command: string,
  sink: NativeChatShellSink
): () => void {
  let cancelled = false
  let unsubscribe: (() => void) | null = null
  const start = async (): Promise<void> => {
    if (
      target.kind === 'environment' &&
      !(await runtimeEnvironmentSupportsCapability(
        target.environmentId,
        AGENT_SESSION_SHELL_COMMAND_RUNTIME_CAPABILITY
      ))
    ) {
      throw new Error(
        translate(
          'components.native-chat.composer.shellNeedsNewerServer',
          'Running ! commands requires a newer Orca server. Update the server and try again.'
        )
      )
    }
    if (cancelled) {
      return
    }
    const handle = await subscribeRuntimeRpc(
      target,
      'agentSession.runShellCommand',
      { sessionId, command },
      {
        onEvent: (result) => {
          if (isShellFrame(result)) {
            sink.frame(result)
          }
        },
        onError: sink.fail,
        onClose: () =>
          sink.fail(
            new Error(
              translate(
                'components.native-chat.composer.shellConnectionClosed',
                'The connection to the host closed.'
              )
            )
          )
      }
    )
    if (cancelled) {
      handle.unsubscribe()
    } else {
      unsubscribe = handle.unsubscribe
    }
  }
  start().catch(sink.fail)
  return () => {
    cancelled = true
    unsubscribe?.()
  }
}
