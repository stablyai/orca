import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'

export async function preflightWorktreeCreationAgentTrust(
  request: WorktreeCreationRequest,
  path: string,
  connectionId?: string | null
): Promise<void> {
  if (!request.agent || !window.api.agentTrust?.markTrusted) {
    return
  }
  const preflight = TUI_AGENT_CONFIG[request.agent].preflightTrust
  if (!preflight) {
    return
  }
  try {
    await window.api.agentTrust.markTrusted({
      preset: preflight,
      workspacePath: path,
      ...(connectionId ? { connectionId } : {})
    })
  } catch {
    // Best-effort: the created workspace must remain usable if trust persistence fails.
  }
}
