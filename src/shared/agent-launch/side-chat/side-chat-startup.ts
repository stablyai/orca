import type { AgentProviderSessionMetadata } from '../../agent-session/lifecycle/agent-session-resume'
import type { AgentStatusEntry } from '../../agent-status/contracts/agent-status-types'
import type {
  AiVaultResumeHostShell,
  AiVaultResumeLaunchSettings
} from '../../ai-vault/resume/ai-vault-resume-startup'
import { buildClaudeSideChatStartup, createClaudeSideChatSessionId } from './claude-side-chat'
import { buildOmpSideChatStartup } from './omp-side-chat'
import { isSideChatAgent, type SideChatStartup } from './side-chat'

type SideChatParent = Pick<AgentStatusEntry, 'agentType' | 'providerSession' | 'model' | 'prompt'>

/** The parent's session once it can be forked: Claude reports it after its first turn; omp at start, before a transcript exists. */
export function sideChatParentSession(
  parent: SideChatParent | undefined
): AgentProviderSessionMetadata | null {
  if (!parent || !isSideChatAgent(parent.agentType) || !parent.providerSession) {
    return null
  }
  if (parent.agentType === 'omp' && !parent.prompt.trim()) {
    return null
  }
  return parent.providerSession
}

export function buildSideChatStartup(args: {
  parent: SideChatParent
  /** Random UUID naming the side chat. */
  sideChatId: string
  host: Pick<AiVaultResumeHostShell, 'platform' | 'liveShell'>
  settings: AiVaultResumeLaunchSettings | null | undefined
  draftPrompt?: string | null
}): SideChatStartup | null {
  const parentSession = sideChatParentSession(args.parent)
  if (!parentSession) {
    return null
  }
  if (args.parent.agentType === 'omp') {
    return buildOmpSideChatStartup({
      parentSession,
      sideChatId: args.sideChatId,
      host: args.host,
      settings: args.settings,
      draftPrompt: args.draftPrompt
    })
  }
  return buildClaudeSideChatStartup({
    parentSession,
    sideSessionId: createClaudeSideChatSessionId(args.sideChatId),
    host: args.host,
    settings: args.settings,
    model: args.parent.model,
    draftPrompt: args.draftPrompt
  })
}
