import type { AppBackgroundSettings } from './app-background-settings'
import type { ClaudeAccountSwitchSettings } from './claude-account-switch-settings'
import type { NativeChatGlobalSettings } from './native-chat-appearance-settings'
import type { WorktreeDeletionPreferences } from './worktree-deletion-preferences'

/** Settings groups owned by their feature modules and composed into GlobalSettings. */
export type GlobalSettingsBase = NativeChatGlobalSettings &
  WorktreeDeletionPreferences &
  ClaudeAccountSwitchSettings &
  AppBackgroundSettings
