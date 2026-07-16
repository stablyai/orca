import type { AgentId } from '../../../shared/custom-agent'

export type NativeChatLaunchPrompt = {
  tabId: string
  agent: AgentId
  text: string
  createdAt: number
  failed?: boolean
}
