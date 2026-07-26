import type { TuiAgent } from '../../../shared/types'

export type NativeChatLaunchPrompt = {
  tabId: string
  agent: TuiAgent
  text: string
  createdAt: number
  failed?: boolean
}
