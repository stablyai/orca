import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import {
  deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab
} from '../../../lib/agent-session/launch/prompt/agent-launch-prompt-delivery'
import { toWebTerminalSurfaceTabId } from '../../../../../shared/workspace-layout/terminal-surface-id'
import type { CreatedWebRuntimeSessionTerminal } from './terminal-create-contracts'

/** Deliver only after the selected create route has settled its startup recipe. */
export async function deliverCreatedWebRuntimeAgentSessionPrompt(
  created: CreatedWebRuntimeSessionTerminal,
  args: {
    agent: TuiAgent
    promptAfterReady?: string
    submitPrompt?: boolean
    forcePromptPaste?: boolean
    launchDraft?: string
  }
): Promise<boolean> {
  if (created.outcome.status === 'failed') {
    return false
  }
  if (args.promptAfterReady !== undefined) {
    if (!created.hostTabId) {
      return false
    }
    return await deliverLaunchPromptToAgentTab({
      tabId: toWebTerminalSurfaceTabId(created.hostTabId),
      content: args.promptAfterReady,
      agent: args.agent,
      submit: args.submitPrompt === true,
      forcePaste: args.forcePromptPaste === true
    }).catch(() => false)
  }
  if (args.launchDraft !== undefined && created.hostTabId) {
    seedNativeChatLaunchDraftForAgentTab({
      tabId: toWebTerminalSurfaceTabId(created.hostTabId),
      agent: args.agent,
      text: args.launchDraft
    })
  }
  return true
}
