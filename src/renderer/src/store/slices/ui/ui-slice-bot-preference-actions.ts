import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'
import { normalizeSidebarBotsHeight } from '../../../../../shared/sidebar-bots-height'
import { DEFAULT_BOT_SIDEBAR_VIEW } from '../../../../../shared/bots/bot-sidebar-view'
import { botChatFoldKey, withBotChatFold } from '../../../../../shared/bots/bot-chat-tree'

/** The bot sidebar's persisted preferences: its height, view, chat folds and hidden bot workspaces. */
export function createUiBotPreferenceActions(set: UISliceSet, get: UISliceGet): Partial<UISlice> {
  return {
    hideBotCreatedWorkspaces: true,
    setHideBotCreatedWorkspaces: (v) => {
      set({ hideBotCreatedWorkspaces: v })
      window.api.ui.set({ hideBotCreatedWorkspaces: v }).catch(console.error)
    },
    botSidebarView: DEFAULT_BOT_SIDEBAR_VIEW,
    setBotSidebarView: (patch) => {
      const botSidebarView = { ...get().botSidebarView, ...patch }
      set({ botSidebarView })
      window.api.ui.set({ botSidebarView }).catch(console.error)
    },
    botChatFolds: {},
    botChatFold: (hostId, botId, chatId) =>
      get().botChatFolds[botChatFoldKey(hostId, botId, chatId)],
    setBotChatFold: (hostId, botId, chatId, fold) => {
      const key = botChatFoldKey(hostId, botId, chatId)
      const botChatFolds = withBotChatFold(get().botChatFolds, key, fold)
      set({ botChatFolds })
      window.api.ui.set({ botChatFolds }).catch(console.error)
    },
    sidebarBotsHeight: null,
    setSidebarBotsHeight: (height) => {
      const normalized = normalizeSidebarBotsHeight(height)
      window.api.ui.set({ sidebarBotsHeight: normalized }).catch(console.error)
      set({ sidebarBotsHeight: normalized })
    }
  }
}
