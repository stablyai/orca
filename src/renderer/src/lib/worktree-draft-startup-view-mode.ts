import { useAppStore } from '@/store'
import { decideInitialAgentTabViewMode } from '@/lib/native-chat-initial-view-mode'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'

export function resolveBackendDraftStartup(
  request: WorktreeCreationRequest
): WorktreeCreationRequest['startup'] {
  if (!request.startup || !request.agent || !request.launchDraftPrompt) {
    return request.startup
  }
  const state = useAppStore.getState()
  const repo = state.repos.find((entry) => entry.id === request.repoId)
  const connectionId = repo ? (repo.connectionId ?? null) : undefined
  const viewMode =
    decideInitialAgentTabViewMode({
      experimentalNativeChat: state.settings?.experimentalNativeChat,
      openAgentTabsInChatByDefault: state.settings?.openAgentTabsInChatByDefault,
      agent: request.agent,
      promptDelivery: 'draft',
      launchDraftText: request.launchDraftPrompt,
      ...(request.agent === 'grok'
        ? {
            nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(connectionId)
          }
        : {})
    }) ?? 'terminal'
  return { ...request.startup, viewMode }
}
