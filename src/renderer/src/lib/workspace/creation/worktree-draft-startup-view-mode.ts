import type { WorktreeCreationRequest } from '@/lib/workspace/creation/pending-worktree-creation'
import { withholdsCloudAgentBackendStartup } from '@/lib/orca-cloud/cloud-create-agent-startup'

export function resolveBackendDraftStartup(
  request: WorktreeCreationRequest
): WorktreeCreationRequest['startup'] {
  // Orca Cloud agent not set up: the pane plans the launch behind its hold, never the host (PC-3b).
  if (withholdsCloudAgentBackendStartup(request)) {
    return undefined
  }
  if (!request.startup || !request.agent || !request.launchDraftPrompt) {
    return request.startup
  }
  return { ...request.startup, viewMode: 'terminal' }
}
