// Hold provisional chats in server-drawn groups until publication; send placement in server IDs so created tabs retain their intended position (L270).

import { newGroupSplitOf } from '@/runtime/workspace-layout/commands/layout-owner-new-group-split'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { StructuredAgentSessionCreateParams } from '../../../../../shared/agent-session/lifecycle/operations/structured-agent-session-create'
import { AGENT_SESSION_CREATE_TAB_PLACEMENT_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/lifecycle/operations/agent-session-create-capabilities'
import { structuredAgentSessionTabId } from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import { findTabByIdOrChatAlias } from '../../../../../shared/agent-session/view/structured-agent-session-tab'
import { useAppStore } from '@/store/index'
import { readCachedRuntimeEnvironmentCapability } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import { serverLayoutApplyRoute } from '@/runtime/workspace-layout/server/server-layout-apply-routes'
import { isFrameDrawnServerWorkspace } from '@/runtime/web-session-tabs-sync/frame-drawn/frame-drawn-server-workspace-set'
import { noteDesktopCreatedServerTab } from './desktop-created-server-tabs'
import type { StructuredLaunchSurfaceAddress } from '../../../lib/agent-session/launch/structured-agent-session-launch-record'

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

/** A deferred chat (a fork) has no tab yet: its captured address names the group and the tabs before it. */
function addressTabPlacement(
  environmentId: string,
  worktreeId: string,
  address: StructuredLaunchSurfaceAddress | undefined
): TabPlacement | undefined {
  if (address?.worktreeId !== worktreeId) {
    return undefined
  }
  const route = serverLayoutApplyRoute(environmentId, worktreeId)
  const afterTabId = route
    ? address.precedingTabIds.map((id) => route.serverTabId(id)).findLast((id) => id !== null)
    : undefined
  if (!address.targetGroupId && !afterTabId) {
    return undefined
  }
  return {
    ...(address.targetGroupId ? { groupId: address.targetGroupId } : {}),
    ...(afterTabId ? { afterTabId } : {})
  }
}

/** Read placement synchronously as create is sent; yielding lets a retiring source invalidate the launch. */
export function withFrameDrawnChatTabPlacement(intent: {
  target: RuntimeClientTarget
  worktreeId: string
  sessionId: string
  params: StructuredAgentSessionCreateParams
  surfaceAddress?: StructuredLaunchSurfaceAddress
}): StructuredAgentSessionCreateParams {
  const environmentId = frameDrawnEnvironment(intent.target, intent.worktreeId)
  if (!environmentId) {
    return intent.params
  }
  // Probed earlier in the launch; unknown sends no place, so the server saves the tab at the group's end.
  if (
    readCachedRuntimeEnvironmentCapability(
      environmentId,
      AGENT_SESSION_CREATE_TAB_PLACEMENT_RUNTIME_CAPABILITY
    ) !== true
  ) {
    return intent.params
  }
  const legacyTabId = structuredAgentSessionTabId(intent.sessionId)
  const tabId =
    findTabByIdOrChatAlias(
      useAppStore.getState().unifiedTabsByWorktree[intent.worktreeId],
      legacyTabId
    )?.id ?? legacyTabId
  const tabPlacement =
    chatTabPlacement(environmentId, intent.worktreeId, tabId) ??
    addressTabPlacement(environmentId, intent.worktreeId, intent.surfaceAddress)
  const split =
    intent.params.forkFrom?.current && tabPlacement?.groupId
      ? newGroupSplitOf(useAppStore.getState(), intent.worktreeId, tabPlacement.groupId, tabId)
      : null
  return tabPlacement
    ? {
        ...intent.params,
        tabPlacement: {
          ...tabPlacement,
          ...split,
          ...(intent.params.forkFrom?.current && intent.surfaceAddress?.precedingTabIds.length === 0
            ? { index: 0 }
            : {})
        }
      }
    : intent.params
}
