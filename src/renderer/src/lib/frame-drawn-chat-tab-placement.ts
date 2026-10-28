// Hold provisional chats in server-drawn groups until publication; send placement in server IDs so created tabs retain their intended position (L270).

import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { StructuredAgentSessionCreateParams } from '../../../shared/structured-agent-session-create'
import { AGENT_SESSION_CREATE_TAB_PLACEMENT_RUNTIME_CAPABILITY } from '../../../shared/agent-session-create-capabilities'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'
import { useAppStore } from '@/store'
import { readCachedRuntimeEnvironmentCapability } from '@/runtime/runtime-rpc-client'
import { serverLayoutApplyRoute } from '@/runtime/server-layout-apply-routes'
import { isFrameDrawnServerWorkspace } from '@/runtime/web-session-tabs-sync/frame-drawn-server-workspaces'
import { noteDesktopCreatedServerTab } from './desktop-created-server-tabs'

function frameDrawnEnvironment(
  target: RuntimeClientTarget | null,
  worktreeId: string
): string | null {
  return target?.kind === 'environment' &&
    isFrameDrawnServerWorkspace(target.environmentId, worktreeId)
    ? target.environmentId
    : null
}

/** Before the server saves the chat, its frames would drop the tab and redraw it at the end. */
export function holdFrameDrawnProvisionalChatTab(
  target: RuntimeClientTarget | null,
  worktreeId: string,
  tabId: string
): void {
  const environmentId = frameDrawnEnvironment(target, worktreeId)
  if (environmentId) {
    noteDesktopCreatedServerTab(environmentId, worktreeId, tabId)
  }
}

type TabPlacement = NonNullable<StructuredAgentSessionCreateParams['tabPlacement']>

/** The chat tab's group, and the server tab before it there; tabs the server lacks are skipped. */
function chatTabPlacement(
  environmentId: string,
  worktreeId: string,
  tabId: string
): TabPlacement | undefined {
  const route = serverLayoutApplyRoute(environmentId, worktreeId)
  const group = useAppStore
    .getState()
    .groupsByWorktree[worktreeId]?.find((entry) => entry.tabOrder.includes(tabId))
  if (!group) {
    return undefined
  }
  // No route while a reconnected stream awaits its snapshot: the group alone (frames keep its id).
  const afterTabId = route
    ? group.tabOrder
        .slice(0, group.tabOrder.indexOf(tabId))
        .map((id) => route.serverTabId(id))
        .findLast((id) => id !== null)
    : undefined
  return { groupId: group.id, ...(afterTabId ? { afterTabId } : {}) }
}

/** Read placement synchronously as create is sent; yielding lets a retiring source invalidate the launch. */
export function withFrameDrawnChatTabPlacement(intent: {
  target: RuntimeClientTarget
  worktreeId: string
  sessionId: string
  params: StructuredAgentSessionCreateParams
}): StructuredAgentSessionCreateParams {
  const environmentId = frameDrawnEnvironment(intent.target, intent.worktreeId)
  if (!environmentId) {
    return intent.params
  }
  // Probed earlier in the launch; unknown sends no place, so the server saves the tab at the group's end.
  const supported =
    readCachedRuntimeEnvironmentCapability(
      environmentId,
      AGENT_SESSION_CREATE_TAB_PLACEMENT_RUNTIME_CAPABILITY
    ) === true
  const tabPlacement = supported
    ? chatTabPlacement(
        environmentId,
        intent.worktreeId,
        structuredAgentSessionTabId(intent.sessionId)
      )
    : undefined
  return tabPlacement ? { ...intent.params, tabPlacement } : intent.params
}
