import type { PersistedUIState } from '../../../../../shared/orca-profiles/persisted-ui-state-types'
import { normalizeSidebarBotsHeight } from '../../../../../shared/sidebar-bots-height'
import { normalizeBotSidebarView } from '../../../../../shared/bots/bot-sidebar-view'
import { normalizeBotChatFolds } from '../../../../../shared/bots/bot-chat-tree'
import type { UISlice } from './ui-slice-contract'
import { hydrateUiCollapseState } from './ui-slice-collapse-actions'
import { hydrateAgentReadState } from './ui-slice-hydration-values'

// Why re-exported: hydration actions import both on one line, keeping that file within max-lines.
export { hydrateOneShotNoticesSeen, sanitizeTaskResumeState } from './ui-slice-hydration-values'

export function hydrateBotSidebarState(
  ui: PersistedUIState
): Pick<
  UISlice,
  | 'hideBotCreatedWorkspaces'
  | 'botSidebarView'
  | 'botChatFolds'
  | 'sidebarBotsHeight'
  | 'sidebarProjectsFirst'
> {
  return {
    hideBotCreatedWorkspaces: ui.hideBotCreatedWorkspaces !== false,
    botSidebarView: normalizeBotSidebarView(ui.botSidebarView),
    botChatFolds: normalizeBotChatFolds(ui.botChatFolds),
    sidebarBotsHeight: normalizeSidebarBotsHeight(ui.sidebarBotsHeight),
    sidebarProjectsFirst: ui.sidebarProjectsFirst === true
  }
}

/** Agents' read state with sidebar bot and collapse state, so hydration stays one spread. */
export function hydrateReadAndBotState(ui: PersistedUIState) {
  return {
    ...hydrateAgentReadState(ui),
    ...hydrateBotSidebarState(ui),
    ...hydrateUiCollapseState(ui)
  }
}
