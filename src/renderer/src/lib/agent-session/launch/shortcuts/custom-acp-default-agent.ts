// The custom ACP agent that new agent tabs in a workspace open, when it is this machine's default.

import {
  savedCustomAcpDefaultAgent,
  type CustomAcpAgent
} from '../../../../../../shared/agent-launch/custom-acp/custom-acp-agent'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host/execution-host'
import type { AppState } from '@/store/types'
import { resolveStructuredAgentSessionOwner } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'

/** Custom agents are defined in this machine's settings, so only its own workspaces run them. */
export function customAcpDefaultAgentForWorktree(
  state: AppState,
  worktreeId: string
): CustomAcpAgent | null {
  const agent = savedCustomAcpDefaultAgent(state.settings)
  return agent && resolveStructuredAgentSessionOwner(state, worktreeId) === LOCAL_EXECUTION_HOST_ID
    ? agent
    : null
}
