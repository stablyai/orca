// Whether a structured chat started in this workspace can carry a review reply on its launch
// prompt. Its host runs the reply, and an older paired server refuses a send that names one.

import { AGENT_SESSION_REVIEW_REPLY_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { useAppStore } from '@/store'
import {
  resolveStructuredAgentSessionOwner,
  structuredAgentSessionTargetForHost
} from '@/runtime/structured-agent-session-owner'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'

/** This client's own host always can; a paired one only once it says so. */
export async function structuredChatHostRunsReviewReplies(worktreeId: string): Promise<boolean> {
  const target = structuredAgentSessionTargetForHost(
    resolveStructuredAgentSessionOwner(useAppStore.getState(), worktreeId)
  )
  if (target?.kind !== 'environment') {
    return true
  }
  return runtimeEnvironmentSupportsCapability(
    target.environmentId,
    AGENT_SESSION_REVIEW_REPLY_RUNTIME_CAPABILITY
  ).catch(() => false)
}
