import { useAppStore } from '@/store'
import { decideInitialAgentTabViewMode } from '@/lib/native-chat-initial-view-mode'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { nativeChatRequiresLocalTranscript } from '@/lib/native-chat-supported-agent'
import { getLocalRepoProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
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
  // Why: pre-creation there is no worktreeId, so the WSL rule resolves from the
  // repo — the same resolution the post-creation sibling
  // (applyBackendSpawnedDraftViewMode) derives from the worktree (#9307
  // expectation 5: auto-open must never land in an endless-loading chat).
  const repoRuntime = request.repoId
    ? getLocalRepoProjectExecutionRuntimeContext(state, request.repoId)
    : undefined
  const wslDistro =
    repoRuntime?.status === 'resolved' && repoRuntime.runtime.kind === 'wsl'
      ? repoRuntime.runtime.distro
      : null
  const viewMode =
    decideInitialAgentTabViewMode({
      experimentalNativeChat: state.settings?.experimentalNativeChat,
      openAgentTabsInChatByDefault: state.settings?.openAgentTabsInChatByDefault,
      agent: request.agent,
      promptDelivery: 'draft',
      launchDraftText: request.launchDraftPrompt,
      wslDistro,
      ...(nativeChatRequiresLocalTranscript(request.agent)
        ? {
            nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(connectionId)
          }
        : {})
    }) ?? 'terminal'
  return { ...request.startup, viewMode }
}
