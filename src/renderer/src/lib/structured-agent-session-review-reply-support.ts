// Whether a structured chat started in this workspace can carry a review reply on its launch
// prompt. Its host runs the reply, and an older paired server refuses a send that names one.

import { AGENT_SESSION_REVIEW_REPLY_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { useAppStore } from '@/store'
import {
  resolveStructuredAgentSessionOwner,
  structuredAgentSessionTargetForHost
} from '@/runtime/structured-agent-session-owner'
import {
  runtimeEnvironmentSupportsCapability,
  type RuntimeClientTarget
} from '@/runtime/runtime-rpc-client'

/** The host a structured chat in this workspace runs on; this client's own when none is named. */
function structuredChatTargetForWorktree(worktreeId: string): RuntimeClientTarget {
  return (
    structuredAgentSessionTargetForHost(
      resolveStructuredAgentSessionOwner(useAppStore.getState(), worktreeId)
    ) ?? { kind: 'local' }
  )
}

/** This client's own host always can; a paired one only once it says so. */
export async function structuredChatHostRunsReviewReplies(worktreeId: string): Promise<boolean> {
  const target = structuredChatTargetForWorktree(worktreeId)
  if (target.kind !== 'environment') {
    return true
  }
  return runtimeEnvironmentSupportsCapability(
    target.environmentId,
    AGENT_SESSION_REVIEW_REPLY_RUNTIME_CAPABILITY
  ).catch(() => false)
}
