// Which machine would adopt an Agent Session History row, and whether it can adopt one at all.
//
// Both halves are settled here, together, before anything is sent. `agentSession.create`'s params
// are a STRICT union: an older host answers an unknown `resumeFrom` with a schema error that a
// client cannot tell from a real refusal, and a host that did accept the call may have started a
// blank session under the adopted name rather than adopting anything. Neither outcome is readable
// from the reply, so the capability is negotiated and the affordance withheld — never probed by
// calling and never followed by a blind create.
//
// The eligibility gate and the action both ask this one function, so what the row offered and what
// the click sends cannot drift apart.

import {
  resolveHostCapabilityEvidence,
  type AgentLaunchRouteStore
} from '@/lib/agent-launch-route-input'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  captureStructuredAgentSessionOwnerForHost,
  type StructuredAgentSessionOwner
} from '@/runtime/structured-agent-session-owner'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  aiVaultSessionResumeInChatOwnerBlocker,
  type AiVaultResumeInChatBlockedReason
} from './ai-vault-session-resume-in-chat'

export type AiVaultResumeInChatOwnerVerdict =
  | {
      adoptable: true
      executionHostId: ExecutionHostId
      /** Pinned on the read that decided this, so a re-pair before the create cannot retarget it. */
      owner: StructuredAgentSessionOwner
    }
  | {
      adoptable: false
      /** Still reported when known, so the eligibility gate can name the refusal in its own order. */
      executionHostId: ExecutionHostId | null
      reason: AiVaultResumeInChatBlockedReason
    }

export function resolveAiVaultSessionResumeInChatOwner(args: {
  store: AgentLaunchRouteStore
  sessionExecutionHostId: string | null | undefined
  sessionFilePath: string | null | undefined
  targetWorkspaceId: string | null
}): AiVaultResumeInChatOwnerVerdict {
  if (!args.targetWorkspaceId) {
    return { adoptable: false, executionHostId: null, reason: 'workspace' }
  }
  const executionHostId = getExecutionHostIdForWorktree(args.store, args.targetWorkspaceId)
  const ownerBlocker = aiVaultSessionResumeInChatOwnerBlocker({
    sessionExecutionHostId: args.sessionExecutionHostId,
    sessionFilePath: args.sessionFilePath,
    targetExecutionHostId: executionHostId
  })
  if (ownerBlocker) {
    return { adoptable: false, executionHostId, reason: ownerBlocker }
  }
  // The owning host's own list, not this machine's: a paired peer answers for what its
  // `agentSession.create` accepts, and a host that has not answered yet is not a host that said no.
  const hostCapabilities = resolveHostCapabilityEvidence(
    args.store,
    executionHostId
  ).hostCapabilities
  if (!hostCapabilities?.includes(STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY)) {
    return { adoptable: false, executionHostId, reason: 'resume-history' }
  }
  return {
    adoptable: true,
    executionHostId,
    owner: captureStructuredAgentSessionOwnerForHost(executionHostId)
  }
}
