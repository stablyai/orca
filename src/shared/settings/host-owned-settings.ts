import * as z from 'zod'
import type { GlobalSettings } from './global-settings-types'
import { DEFAULT_NATIVE_CHAT_IDLE_STOP_MINUTES } from '../native-chat/settings/native-chat-idle-stop'

/** Settings a host reads for its own work, so Settings edits them on the host its picker names. */
const HostOwnedSettingsSchema = z.object({
  branchPrefix: z.enum(['git-username', 'custom', 'none']),
  branchPrefixCustom: z.string(),
  nestWorkspaces: z.boolean(),
  refreshLocalBaseRefOnWorktreeCreate: z.boolean(),
  localBaseRefSuggestionDismissed: z.boolean(),
  codexShareHistoryAcrossAccounts: z.boolean(),
  deleteChatHistoryWithWorkspace: z.boolean(),
  nativeChatAutoContinueAfterUsageLimit: z.boolean(),
  nativeChatIdleStopMinutes: z.number().min(0),
  nativeChatInheritShellEnvironment: z.boolean(),
  // Names are filtered when a chat starts (normalizeNativeChatShellEnvironmentVariables).
  nativeChatShellEnvironmentVariables: z.array(z.string()),
  // Launches the host starts itself (CLI, orchestration workers); desktop launches send their own.
  agentDefaultSurface: z.enum(['chat', 'terminal']),
  // Whose sign-in chats on the Google account method use: 'auto' follows what the host has (see
  // antigravityChatRoute), 'agy' is agy's own login, 'orca' Orca's built-in sign-in on its server.
  antigravityGoogleSignIn: z.enum(['auto', 'agy', 'orca']),
  // One-shot text helpers run on the host, which retries them on its own saved accounts.
  textGenerationSubscriptionFailoverEnabled: z.boolean()
} satisfies { [K in keyof GlobalSettings]?: z.ZodType<NonNullable<GlobalSettings[K]>> })

export type HostOwnedSettings = z.output<typeof HostOwnedSettingsSchema>
export type HostOwnedSettingKey = keyof HostOwnedSettings

/** What the host acts on when its profile has no value. */
const HOST_OWNED_SETTING_FALLBACKS: HostOwnedSettings = {
  branchPrefix: 'git-username',
  branchPrefixCustom: '',
  nestWorkspaces: true,
  refreshLocalBaseRefOnWorktreeCreate: false,
  localBaseRefSuggestionDismissed: false,
  codexShareHistoryAcrossAccounts: true,
  deleteChatHistoryWithWorkspace: false,
  nativeChatAutoContinueAfterUsageLimit: false,
  nativeChatIdleStopMinutes: DEFAULT_NATIVE_CHAT_IDLE_STOP_MINUTES,
  nativeChatInheritShellEnvironment: true,
  nativeChatShellEnvironmentVariables: [],
  agentDefaultSurface: 'terminal',
  antigravityGoogleSignIn: 'auto',
  textGenerationSubscriptionFailoverEnabled: false
}

export const HOST_OWNED_SETTING_KEYS = HostOwnedSettingsSchema.keyof().options

/** Optional fields for the strict settings.update schema. */
export const HOST_OWNED_SETTING_UPDATE_SHAPE = HostOwnedSettingsSchema.partial().shape

/** A host's reported value, or undefined when an older host neither reports nor accepts the key. */
export function readHostOwnedSetting<K extends HostOwnedSettingKey>(
  settings: Readonly<Record<string, unknown>>,
  key: K
): HostOwnedSettings[K] | undefined {
  const parsed = HostOwnedSettingsSchema.shape[key].safeParse(settings[key])
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: shape[key] is the schema whose output is HostOwnedSettings[K]; TS cannot correlate the generic index.
  return parsed.success ? (parsed.data as HostOwnedSettings[K]) : undefined
}

/** The value the host acts on: its saved value, or the fallback when it has none. */
export function resolveHostOwnedSetting<K extends HostOwnedSettingKey>(
  settings: Readonly<Record<string, unknown>>,
  key: K
): HostOwnedSettings[K] {
  return readHostOwnedSetting(settings, key) ?? HOST_OWNED_SETTING_FALLBACKS[key]
}

/** Every key, always present, so a client can tell this host accepts it (settings.update is strict). */
export function projectHostOwnedSettings(
  settings: Readonly<Record<string, unknown>>
): HostOwnedSettings {
  return HostOwnedSettingsSchema.parse(
    Object.fromEntries(
      HOST_OWNED_SETTING_KEYS.map((key) => [key, resolveHostOwnedSetting(settings, key)])
    )
  )
}
