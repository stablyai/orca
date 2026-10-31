import type { BrowserExtensionGlobalSettings } from './browser-extension-settings'
import type { ClaudeAgentViewSettings } from './claude-agent-view'
import type { BrowserLinkOpeningSettings } from './browser-link-opening-settings'
import type { ClaudeAccountSwitchSettings } from './claude-account-switch-settings'
import type { ExternalConversationSettings } from './external-conversation-settings'
import type { NativeChatGlobalSettings } from './native-chat/native-chat-appearance-settings'
import type { PluginAppearanceSettings } from './plugin-appearance-settings-types'
import type { PluginFileTypeSuggestionSettings } from './plugins/contributions/plugin-file-type'
import type { PluginUpdatePolicySettings } from './plugins/catalog/plugin-update-policy'
import type { PluginSystemSettings } from './plugins/plugin-system-settings'
import type { WorktreeDeletionPreferences } from './worktree-deletion-preferences'
import type { TerminalFocusSettings } from './terminal-focus-settings'
import type { AgentPermissionGlobalSettings } from './tui-agent-permission-choice'

/** Settings groups owned by their feature modules and composed into GlobalSettings. */
export type GlobalSettingsBase = ClaudeAgentViewSettings &
  NativeChatGlobalSettings &
  WorktreeDeletionPreferences &
  ClaudeAccountSwitchSettings &
  AgentPermissionGlobalSettings &
  ExternalConversationSettings &
  BrowserLinkOpeningSettings &
  BrowserExtensionGlobalSettings &
  PluginAppearanceSettings &
  PluginFileTypeSuggestionSettings &
  PluginUpdatePolicySettings &
  PluginSystemSettings &
  TerminalFocusSettings
