import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { StructuredAgentSessionCreateParams } from '../../../../../shared/agent-session/lifecycle/operations/structured-agent-session-create'
import { AGENT_SESSION_CREATE_TAB_ID_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/lifecycle/operations/agent-session-create-capabilities'
import { isAgentSessionSlotTabId } from '../../../../../shared/agent-session/view/agent-session-slot-tab-id'
import { structuredAgentSessionTabId } from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import { findTabByIdOrChatAlias } from '../../../../../shared/agent-session/view/structured-agent-session-tab'
import { readCachedRuntimeEnvironmentCapability } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import { useAppStore } from '@/store/index'

/** An older host derives the chat's tab id itself, so it is never handed a minted one. */
export function hostTakesChatTabId(target: RuntimeClientTarget | null): boolean {
  return (
    target?.kind === 'local' ||
    (target?.kind === 'environment' &&
      readCachedRuntimeEnvironmentCapability(
        target.environmentId,
        AGENT_SESSION_CREATE_TAB_ID_RUNTIME_CAPABILITY
      ) === true)
  )
}

/** Create carries the chat's minted slot id so the host saves its tab under the id this window draws. */
export function withMintedChatTabId(intent: {
  target: RuntimeClientTarget
  worktreeId: string
  sessionId: string
  params: StructuredAgentSessionCreateParams
}): StructuredAgentSessionCreateParams {
  const tabId = findTabByIdOrChatAlias(
    useAppStore.getState().unifiedTabsByWorktree?.[intent.worktreeId],
    structuredAgentSessionTabId(intent.sessionId)
  )?.id
  return tabId && isAgentSessionSlotTabId(tabId) && hostTakesChatTabId(intent.target)
    ? { ...intent.params, tabId }
    : intent.params
}
