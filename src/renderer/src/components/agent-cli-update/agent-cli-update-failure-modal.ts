import { useAppStore } from '@/store/index'
import {
  isAgentCliUpdateAgent,
  type AgentCliUpdateAgent
} from '../../../../shared/agent-launch/installation/agent-cli-update'

export type AgentCliUpdateFailureRequest = {
  hostKey: string
  agent: AgentCliUpdateAgent
  /** The opening surface's own update, so a chat retries its start once the CLI is current. */
  tryAgain: () => unknown
}

/** Root-hosted so the dialog outlives the popover or picker whose chip opened it. */
export function openAgentCliUpdateFailure(request: AgentCliUpdateFailureRequest): void {
  useAppStore.getState().openModal('agent-cli-update-failed', request)
}

function isTryAgain(value: unknown): value is () => unknown {
  return typeof value === 'function'
}

export function readAgentCliUpdateFailureRequest(
  data: Record<string, unknown>
): AgentCliUpdateFailureRequest | null {
  const { hostKey, agent, tryAgain } = data
  return typeof hostKey === 'string' &&
    typeof agent === 'string' &&
    isAgentCliUpdateAgent(agent) &&
    isTryAgain(tryAgain)
    ? { hostKey, agent, tryAgain }
    : null
}
