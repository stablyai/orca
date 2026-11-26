import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { getRemoteRuntimePtyOwner } from '@/runtime/hosted-terminals/identity/remote-runtime-pty-owner'
import type { AgentQuestionAnsweredInferenceRequest } from '../../../../../../shared/agent-status/lifecycle/agent-question-answered-intent'

/** Send a question inference to the process that owns the pane's hook state: this desktop's main
 *  for local PTYs, the owning runtime (e.g. orcad on an SSH host) for a Codex skip on a remote one. */
export function routeQuestionAnsweredInference(
  ptyId: string | null,
  request: AgentQuestionAnsweredInferenceRequest
): Promise<boolean> {
  const owner = ptyId ? getRemoteRuntimePtyOwner(ptyId) : null
  if (!owner) {
    return window.api.agentStatus.inferQuestionAnswered(request)
  }
  // Remote rows mirror the host's under another pane key; only the skip has a host method.
  if (!request.codexSkip) {
    return Promise.resolve(false)
  }
  return callRuntimeRpc<{ applied: boolean }>(
    owner.target,
    'terminal.inferCodexQuestionSkip',
    { terminal: owner.terminal, prompt: request.baselinePrompt },
    { timeoutMs: 8000 }
  ).then((result) => result.applied)
}
