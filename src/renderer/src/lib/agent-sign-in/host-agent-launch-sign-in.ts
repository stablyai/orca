import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { HostAgentLaunch } from '@/store/slices/worktrees/create/worktree-create-payload'
import type { WorktreeCreationRequest } from '@/lib/workspace/creation/pending-worktree-creation'
import { hostPlannableAgentLaunch } from '@/lib/workspace/creation/worktree-creation-host-agent-launch'
import { isAgentSignedOutOnHost } from './agent-sign-in-gate-store'
import { cloudAgentLaunchDecision } from '@/lib/orca-cloud/cloud-agent-launch-hold'
import { isOrcaCloudEnvironmentId } from '@/lib/orca-cloud/orca-cloud-environment-id'

function creationRuntimeEnvironmentId(request: WorktreeCreationRequest): string | null {
  const host = parseExecutionHostId(
    request.workspaceRunContext?.hostId ?? request.executionHostId ?? null
  )
  return host?.kind === 'runtime' ? host.environmentId : null
}

/** Whether the creation's Claude/Codex is known signed out on its runtime host. */
export function hostSignInCheck(request: WorktreeCreationRequest): Promise<boolean> {
  const environmentId = creationRuntimeEnvironmentId(request)
  const agent = request.agent
  if (!environmentId || (agent !== 'claude' && agent !== 'codex')) {
    return Promise.resolve(false)
  }
  return isAgentSignedOutOnHost(environmentId, agent)
}

/** A host-started agent can't show the sign-in card, so a signed-out host gets the pane-planned launch. */
export async function signedInHostLaunch(
  request: WorktreeCreationRequest,
  signedOut: Promise<boolean>,
  askedFor?: WorktreeCreationRequest
): Promise<HostAgentLaunch | undefined> {
  const launch = hostPlannableAgentLaunch(request)
  if (!launch) {
    return undefined
  }
  // A new VM has no host until it is provisioned, so the early answer was about no host at all.
  const moved =
    askedFor !== undefined &&
    creationRuntimeEnvironmentId(askedFor) !== creationRuntimeEnvironmentId(request)
  if (await (moved ? hostSignInCheck(request) : signedOut)) {
    return undefined
  }
  // PC-3b: an Orca Cloud agent whose Orca account isn't set up (or expired) must hold behind the pane
  // strip; a host-started launch would skip it and land on the agent's own /login. Plan it in the
  // pane instead, prompt and all. Account-ready creates keep the faster host-planned launch.
  return (await orcaCloudLaunchHolds(request)) ? undefined : launch
}

async function orcaCloudLaunchHolds(request: WorktreeCreationRequest): Promise<boolean> {
  const environmentId = creationRuntimeEnvironmentId(request)
  const agent = request.agent
  if (!environmentId || (agent !== 'claude' && agent !== 'codex')) {
    return false
  }
  return (
    isOrcaCloudEnvironmentId(environmentId) && (await cloudAgentLaunchDecision(agent)) === 'hold'
  )
}
