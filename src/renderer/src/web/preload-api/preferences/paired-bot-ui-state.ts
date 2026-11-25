import type { PersistedUIState } from '../../../../../shared/orca-profiles/persisted-ui-state-types'

type BotUiKey =
  | 'hideBotCreatedWorkspaces'
  | 'botSidebarView'
  | 'botSidebarSearchQuery'
  | 'botChatFolds'
type BotUiState = { [K in BotUiKey]: PersistedUIState[K] }

/** The Bots section's view stays this device's own when a paired host's UI state merges in. */
export function pinnedBotUiState(local: PersistedUIState): BotUiState {
  return {
    hideBotCreatedWorkspaces: local.hideBotCreatedWorkspaces,
    botSidebarView: local.botSidebarView,
    botSidebarSearchQuery: local.botSidebarSearchQuery,
    botChatFolds: local.botChatFolds
  }
}
