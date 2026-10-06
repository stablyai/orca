import { useAppStore } from '@/store'
import { hostLaunchViewRequest } from '@/lib/agent-launch-host-view-request'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'

type BackendAgentRequest = Pick<WorktreeCreationRequest, 'agent' | 'repoId' | 'launchDraftPrompt'>

/** This device's view request for the agent tab a backend worktree create spawns. */
export function backendAgentViewRequest(
  request: BackendAgentRequest
): ReturnType<typeof hostLaunchViewRequest> {
  if (!request.agent) {
    return {}
  }
  const state = useAppStore.getState()
  const repo = state.repos.find((entry) => entry.id === request.repoId)
  const connectionId = repo ? (repo.connectionId ?? null) : undefined
  return hostLaunchViewRequest(state.settings, {
    agent: request.agent,
    ...(request.launchDraftPrompt
      ? { promptDelivery: 'draft' as const, launchDraftText: request.launchDraftPrompt }
      : {}),
    nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(connectionId)
  })
}

/**
 * The startup carrying that request, so the host stamps the view at creation (every agent startup,
 * not only drafts: STA-6412).
 */
export function backendAgentStartup(
  request: BackendAgentRequest & Pick<WorktreeCreationRequest, 'startup'>
): WorktreeCreationRequest['startup'] {
  return request.startup
    ? { ...request.startup, ...backendAgentViewRequest(request) }
    : request.startup
}

/** The host-built `startupDraft` agent launch and this device's view request for it. */
export function hostBuiltDraftCreateOptions(request: BackendAgentRequest): {
  startupDraft?: string
  startupViewMode?: 'terminal'
  launcherDefaultView?: 'terminal' | 'chat'
} {
  if (!request.agent || !request.launchDraftPrompt) {
    return {}
  }
  const { viewMode, launcherDefaultView } = backendAgentViewRequest(request)
  return {
    startupDraft: request.launchDraftPrompt,
    ...(viewMode ? { startupViewMode: viewMode } : {}),
    ...(launcherDefaultView ? { launcherDefaultView } : {})
  }
}
