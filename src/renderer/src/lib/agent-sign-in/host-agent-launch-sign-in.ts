import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { HostAgentLaunch } from '@/store/slices/worktrees/create/worktree-create-payload'
import type { WorktreeCreationRequest } from '@/lib/workspace/creation/pending-worktree-creation'
import { hostPlannableAgentLaunch } from '@/lib/workspace/creation/worktree-creation-host-agent-launch'
import { isAgentSignedOutOnHost } from './agent-sign-in-gate-store'

/** Whether the creation's Claude/Codex is known signed out on its runtime host. */
export function hostSignInCheck(request: WorktreeCreationRequest): Promise<boolean> {
  const host = parseExecutionHostId(
    request.workspaceRunContext?.hostId ?? request.executionHostId ?? null
  )
  const agent = request.agent
  if (host?.kind !== 'runtime' || (agent !== 'claude' && agent !== 'codex')) {
    return Promise.resolve(false)
  }
  return isAgentSignedOutOnHost(host.environmentId, agent)
}

/** A host-started agent can't show the sign-in card, so a signed-out host gets the pane-planned launch. */
export async function signedInHostLaunch(
  request: WorktreeCreationRequest,
  signedOut: Promise<boolean>
): Promise<HostAgentLaunch | undefined> {
  const launch = hostPlannableAgentLaunch(request)
  return launch && (await signedOut) ? undefined : launch
}
