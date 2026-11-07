import { useAppStore } from '@/store'
import { getLaunchConfigForEntry } from '@/store/slices/agent-status/agent-status-launch-config'
import { structuredAgentSessionHostSupports } from '@/runtime/structured-agent-session-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { STRUCTURED_AGENT_SESSION_SOURCE_TERMINAL_ARGS_RUNTIME_CAPABILITY } from '../../../../shared/agent-session/structured-agent-session-surface-capabilities'
import { RESUME_SOURCE_AGENT_ARGS_MAX_CHARS } from '../../../../shared/rpc-contract/structured-agent-session-resume-params'
import type { CliChatResumeSource } from './cli-chat-resume-source'

/** Read before the close drops the pane's launch record; hand-typed shell flags are never recorded. */
export async function cliChatResumeSourceAgentArgs(
  target: RuntimeClientTarget,
  source: CliChatResumeSource
): Promise<string | undefined> {
  const state = useAppStore.getState()
  const entry = state.agentStatusByPaneKey[source.paneKey]
  const agentArgs =
    entry?.providerSession?.id === source.providerSessionId
      ? getLaunchConfigForEntry(state, entry)?.agentArgs.trim()
      : undefined
  return agentArgs &&
    agentArgs.length <= RESUME_SOURCE_AGENT_ARGS_MAX_CHARS &&
    (await structuredAgentSessionHostSupports(
      target,
      STRUCTURED_AGENT_SESSION_SOURCE_TERMINAL_ARGS_RUNTIME_CAPABILITY
    ))
    ? agentArgs
    : undefined
}
