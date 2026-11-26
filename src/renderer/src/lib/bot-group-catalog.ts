import type { BotGroup } from '../../../shared/bots/bot-group'
import { botGroupRoomLabel } from './bot-group-room-label'
import { refreshBotHostGroups } from './bot-group-list'
import { botTarget, callBotRpc } from './bot-hosts'
import { callBotGroupRpc } from './bot-group-rpc'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { folderWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/workspace-layout/layout-owner-switch'
import { openContentTabThroughLayoutOwner } from '@/runtime/workspace-layout/intents/layout-owner-content-tab-open'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../shared/identifiers/non-secure-context-uuid'
import { activateAndRevealFolderWorkspaceWithOutcome } from './workspace/activation/worktree-activation'
import type { AppState } from '../store/types'
import { selectFrontTab } from '../store/slices/tabs/active-tab-selection'

/** The tab of one room in the group: the original room's, or a thread's. */
function roomTab(state: AppState, group: Pick<BotGroup, 'folderWorkspaceId'>, roomId: string) {
  return state.unifiedTabsByWorktree[folderWorkspaceKey(group.folderWorkspaceId)]?.find(
    (tab) => tab.contentType === 'room' && tab.entityId === roomId
  )
}

function showRoomTab(workspace: string, tabId: string): void {
  const state = useAppStore.getState()
  const groupId = state.getTab(tabId)?.groupId
  if (groupId) {
    state.focusGroup(workspace, groupId)
  }
  state.activateTab(tabId, { worktreeId: workspace })
  state.setActiveTabType('agent-session', workspace)
}

/** Opens the group's home and focuses its room tab there, adding the tab the first time. */
export function openBotGroup(group: BotGroup): Promise<void> {
  return openBotGroupRoom(group, group.id, group.name)
}

/** A new thread in the group, opened in its own room tab beside the others. */
export async function startBotGroupThread(group: BotGroup): Promise<void> {
  const { group: saved, threadId } = await callBotGroupRpc<{ group: BotGroup; threadId: string }>(
    group,
    'bots.groups.newThread',
    { groupId: group.id }
  )
  await refreshBotHostGroups(group.hostId)
  await openBotGroupRoom(saved, threadId, botGroupRoomLabel(saved, threadId))
}

/** A room whose home can't open; a blocked path has already shown its own notice. */
export class BotGroupRoomUnavailableError extends Error {
  constructor(
    message: string,
    readonly userNotified: boolean
  ) {
    super(message)
  }
}

/** Opens one room of the group, the original or a thread, focusing its tab or adding it. */
export async function openBotGroupRoom(
  group: BotGroup,
  roomId: string,
  label: string
): Promise<void> {
  await useAppStore
    .getState()
    .fetchFolderWorkspaces({ runtimeEnvironmentId: runtimeTargetEnvironmentId(botTarget(group)) })
  // Group homes are not sidebar rows, so there is nothing to reveal.
  const outcome = activateAndRevealFolderWorkspaceWithOutcome(group.folderWorkspaceId, {
    executionHostId: group.hostId,
    revealInSidebar: false
  })
  if ('refused' in outcome) {
    throw new BotGroupRoomUnavailableError(
      translate(
        'bots.groups.homeUnavailable',
        'The home workspace for “{{name}}” on {{host}} is unavailable.',
        {
          name: group.name,
          host: selectExecutionHostDisplayLabel(useAppStore.getState(), group.hostId)
        }
      ),
      outcome.refused.failureNotified
    )
  }
  const workspace = folderWorkspaceKey(group.folderWorkspaceId)
  const state = useAppStore.getState()
  const existing = roomTab(state, group, roomId)
  if (existing) {
    showRoomTab(workspace, existing.id)
    return
  }
  const drawHere = (tabId?: string): string =>
    state.createUnifiedTab(workspace, 'room', {
      ...(tabId ? { id: tabId } : {}),
      entityId: roomId,
      executionHostId: group.hostId,
      label
    }).id
  const groupId = ORCA_LAYOUT_OWNER_IS_MAIN
    ? (state.activeGroupIdByWorktree[workspace] ?? state.ensureWorktreeRootGroup(workspace))
    : undefined
  if (groupId) {
    const tabId = createBrowserUuid()
    const sent = openContentTabThroughLayoutOwner(state, {
      worktreeId: workspace,
      entityId: roomId,
      command: { type: 'openRoomTab', tabId, botGroupId: roomId, groupId },
      facts: { label },
      shown: (shownId) => showRoomTab(workspace, shownId),
      drawHere: () => drawHere(tabId)
    })
    if (sent) {
      return
    }
  }
  showRoomTab(workspace, drawHere())
}

/** The room in front, the group's or a thread's, for the sidebar's current row. */
export function selectActiveBotGroupRoomId(state: AppState): string | null {
  const tab = selectFrontTab(state)
  return tab?.contentType === 'room' ? tab.entityId : null
}

/** Deletes the group on its host, then closes its room tab. */
export async function deleteBotGroup(group: BotGroup): Promise<void> {
  await callBotRpc(group, 'bots.groups.delete', { groupId: group.id })
  const state = useAppStore.getState()
  for (const roomId of [group.id, ...(group.threads ?? []).map((thread) => thread.id)]) {
    const room = roomTab(state, group, roomId)
    if (room) {
      state.closeUnifiedTab(room.id)
    }
  }
  await refreshBotHostGroups(group.hostId)
}
