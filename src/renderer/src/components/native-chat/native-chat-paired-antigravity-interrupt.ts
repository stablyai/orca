import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  ANTIGRAVITY_CHAT_INTERRUPT_CAPABILITY,
  type AntigravityChatInterruptRequest,
  type AntigravityChatInterruptResult
} from '../../../../shared/antigravity-chat-interrupt'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'

type Dependencies = {
  environmentId: string
  terminal: string
  getStatusEntry(): AgentStatusEntry | undefined
  supports?(): Promise<boolean>
  interrupt?(
    request: AntigravityChatInterruptRequest,
    signal: AbortSignal
  ): Promise<AntigravityChatInterruptResult>
}

function capture(
  entry: AgentStatusEntry | undefined,
  terminal: string
): AntigravityChatInterruptRequest | null {
  const observation = entry?.observation
  const session = entry?.providerSession
  return entry?.agentType === 'antigravity' &&
    entry.state === 'working' &&
    observation &&
    session?.key === 'conversation_id'
    ? {
        terminal,
        providerSessionId: session.id,
        observation: {
          authorityId: observation.authorityId,
          incarnation: observation.incarnation,
          revision: observation.revision
        }
      }
    : null
}

/** Probe before writing; a legacy void terminal.send cannot prove cancellation acceptance. */
export function createPairedAntigravityInterrupt(deps: Dependencies) {
  let disposed = false
  let pending: Promise<AntigravityChatInterruptResult> | null = null
  const controller = new AbortController()
  const supports =
    deps.supports ??
    (() =>
      runtimeEnvironmentSupportsCapability(
        deps.environmentId,
        ANTIGRAVITY_CHAT_INTERRUPT_CAPABILITY
      ))
  const interrupt =
    deps.interrupt ??
    ((request, signal) =>
      callRuntimeRpc<AntigravityChatInterruptResult>(
        { kind: 'environment', environmentId: deps.environmentId },
        'nativeChat.interruptAntigravity',
        request,
        { signal }
      ))
  async function execute(): Promise<AntigravityChatInterruptResult> {
    const request = capture(deps.getStatusEntry(), deps.terminal)
    if (!request || disposed) {
      return { accepted: false, inferred: false, reason: 'stale' }
    }
    const supported = await supports()
    if (disposed) {
      return { accepted: false, inferred: false, reason: 'stale' }
    }
    if (!supported) {
      return { accepted: false, inferred: false, reason: 'unsupported' }
    }
    const current = capture(deps.getStatusEntry(), deps.terminal)
    if (
      disposed ||
      !current ||
      current.providerSessionId !== request.providerSessionId ||
      current.observation.authorityId !== request.observation.authorityId ||
      current.observation.incarnation !== request.observation.incarnation ||
      current.observation.revision !== request.observation.revision
    ) {
      return { accepted: false, inferred: false, reason: 'stale' }
    }
    return interrupt(request, controller.signal)
  }
  return {
    cancel(): Promise<AntigravityChatInterruptResult> {
      pending ??= execute().finally(() => {
        pending = null
      })
      return pending
    },
    dispose(): void {
      disposed = true
      controller.abort()
    }
  }
}
