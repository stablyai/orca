import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'

export function resolveBackendDraftStartup(
  request: WorktreeCreationRequest
): WorktreeCreationRequest['startup'] {
  if (!request.startup || !request.agent || !request.launchDraftPrompt) {
    return request.startup
  }
  return { ...request.startup, viewMode: 'terminal' }
}
