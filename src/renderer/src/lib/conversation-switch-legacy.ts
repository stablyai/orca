import { toast } from 'sonner'
import { conversationSwitchFailureText } from './conversation-switch-feedback'
import { adoptsCliConversations } from '../../../shared/structured-agent-cli-conversation-adoption'
import { runCliChatResume } from '@/components/tab-bar/cli-chat-resume-run'
import { switchIntoOwnerLegacy } from '@/components/tab-bar/cli-chat-resume-owner-return'

import { newAgentLaunchRequestId } from './agent-launch-request-id'
import { resumeAiVaultSessionInNewChat } from '@/components/right-sidebar/ai-vault-session-resume-in-chat-launch'

import type { ConversationSwitch } from './conversation-switch-state'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
/** A chat move where the agent or host has no in-place switch: the earlier resume into a chat
 *  (a terminal's Continue in Chat UI closes it, waits for its exit, then opens the chat). */
export function runLegacyConversationSwitch(args: ConversationSwitch, target: RuntimeClientTarget) {
  const reportFailure = (error: unknown) => toast.error(conversationSwitchFailureText(error, args))
  if (args.source) {
    return runCliChatResume(args.source)
  } else if (args.sessionId) {
    return switchIntoOwnerLegacy(
      { agent: args.agent, tabId: args.chatTabId ?? '', workspaceId: args.workspaceId },
      { sessionId: args.sessionId, workspaceId: args.workspaceId },
      target,
      reportFailure
    )
  } else if (args.history && adoptsCliConversations(args.agent)) {
    return resumeAiVaultSessionInNewChat(
      args.history,
      args.agent,
      args.workspaceId,
      newAgentLaunchRequestId(),
      undefined,
      reportFailure
    )
  }
  return undefined
}
