import { webTerminalPlacementParentTabId } from '../placement/web-session-terminal-placement'
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
    rendererTabId?: string
    beforePaste?: () => boolean
    launchPty?: Promise<string | null>
    promptAfterReady?: string
    submitPrompt?: boolean
    forcePromptPaste?: boolean
    launchDraft?: string
  }
): Promise<boolean> {
  if (created.outcome.status === 'failed') {
    return false
  }
  const tabId =
    args.rendererTabId ??
    (created.hostTabId
      ? toWebTerminalSurfaceTabId(webTerminalPlacementParentTabId(created.hostTabId))
      : undefined)
  if (args.promptAfterReady !== undefined) {
    if (!tabId) {
      return false
    }
    return await deliverLaunchPromptToAgentTab({
      tabId,
      content: args.promptAfterReady,
      agent: args.agent,
      submit: args.submitPrompt === true,
      forcePaste: args.forcePromptPaste === true,
      beforePaste: args.beforePaste,
      launchPty: args.launchPty
    }).catch(() => false)
  }
  if (args.launchDraft !== undefined && tabId) {
    seedNativeChatLaunchDraftForAgentTab({
      tabId,
      agent: args.agent,
      text: args.launchDraft
    })
  }
  return true
}
