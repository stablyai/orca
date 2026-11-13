import type { NativeChatProviderChoices } from './native-chat-providers'

export type NativeChatAppearanceSettings = {
  /** Absent follows the IDE font. */
  fontFamily?: string
  /** Chat text size in px, 12–20; absent = 14. */
  fontSize?: number
  /** Code text size in px, 10–18; absent = 12. */
  codeFontSize?: number
  /** Transcript and composer width; absent = comfortable (46rem). */
  width?: 'comfortable' | 'wide' | 'full'
  /** Chat contrast, 50–150; absent = 100. */
  contrast?: number
  /** Follow the terminal interface font and theme; absent = false. */
  matchTerminalInterface?: boolean
}

export type AgentDefaultSurface = 'chat' | 'terminal'

export type NativeChatGlobalSettings = {
  /** Unlisted agents follow this default; absent means terminal. */
  agentDefaultSurface?: AgentDefaultSurface
  nativeChatAppearance?: NativeChatAppearanceSettings
  /** Off keeps chats unnamed without running a naming agent. Absent means on. */
  nativeChatAutoName?: boolean
  /** Explicit per-agent overrides of the default surface. */
  nativeChatProviders?: NativeChatProviderChoices
  /** Own sends bring the latest into view; off keeps a reader who scrolled up in place. Absent means on. */
  nativeChatScrollToLatestOnSend?: boolean
  /** The changed-files card under each turn that edited files. Absent means on. */
  nativeChatTurnDiffSummary?: boolean
  /** Lines saying how CI went on a pull request the chat opened or pushed to. Absent means on. */
  nativeChatCiResultLines?: boolean
  /** A "New" line above what arrived while the reader was away. Absent follows the default below. */
  nativeChatMarkNewMessages?: boolean
}

/** Not written into default settings, so flipping this reaches everyone who never chose. */
const NATIVE_CHAT_MARKS_NEW_MESSAGES_BY_DEFAULT = true

export function nativeChatMarksNewMessages(
  settings: { readonly nativeChatMarkNewMessages?: unknown } | null | undefined
): boolean {
  const value = settings?.nativeChatMarkNewMessages
  return typeof value === 'boolean' ? value : NATIVE_CHAT_MARKS_NEW_MESSAGES_BY_DEFAULT
}

/** Only explicit OFF keeps a reader's place on send. */
export function nativeChatScrollsToLatestOnSend(
  settings: { readonly nativeChatScrollToLatestOnSend?: unknown } | null | undefined
): boolean {
  return settings?.nativeChatScrollToLatestOnSend !== false
}

/** Only explicit OFF hides the per-turn changed-files card. */
export function nativeChatShowsTurnDiffSummary(
  settings: { readonly nativeChatTurnDiffSummary?: unknown } | null | undefined
): boolean {
  return settings?.nativeChatTurnDiffSummary !== false
}

/** Only explicit OFF hides CI result lines; the host keeps recording them either way. */
export function nativeChatShowsCiResultLines(
  settings: { readonly nativeChatCiResultLines?: unknown } | null | undefined
): boolean {
  return settings?.nativeChatCiResultLines !== false
}

export const DEFAULT_NATIVE_CHAT_FONT_SIZE = 14
export const DEFAULT_NATIVE_CHAT_CODE_FONT_SIZE = 12
export const DEFAULT_NATIVE_CHAT_CONTRAST = 100

function normalizeSize(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback
}

export function normalizeNativeChatAppearanceSettings(
  value: unknown
): NativeChatAppearanceSettings | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const fontFamily =
    'fontFamily' in value && typeof value.fontFamily === 'string' ? value.fontFamily.trim() : ''
  const fontSize = normalizeSize('fontSize' in value ? value.fontSize : undefined, 12, 20, 14)
  const codeFontSize = normalizeSize(
    'codeFontSize' in value ? value.codeFontSize : undefined,
    10,
    18,
    12
  )
  const contrast = normalizeSize('contrast' in value ? value.contrast : undefined, 50, 150, 100)
  const matchTerminalInterface =
    'matchTerminalInterface' in value && value.matchTerminalInterface === true
  const width =
    'width' in value && (value.width === 'wide' || value.width === 'full') ? value.width : undefined
  const normalized: NativeChatAppearanceSettings = {
    ...Object.fromEntries(
      Object.entries(value).filter(
        ([key]) =>
          ![
            'fontFamily',
            'fontSize',
            'codeFontSize',
            'width',
            'contrast',
            'matchTerminalInterface'
          ].includes(key)
      )
    ),
    ...(fontFamily ? { fontFamily } : {}),
    ...(fontSize !== DEFAULT_NATIVE_CHAT_FONT_SIZE ? { fontSize } : {}),
    ...(codeFontSize !== DEFAULT_NATIVE_CHAT_CODE_FONT_SIZE ? { codeFontSize } : {}),
    ...(width ? { width } : {}),
    ...(contrast !== DEFAULT_NATIVE_CHAT_CONTRAST ? { contrast } : {}),
    ...(matchTerminalInterface ? { matchTerminalInterface } : {})
  }
  return Object.keys(normalized).length ? normalized : undefined
}

export function resolveNativeChatAppearanceSettings(
  value: unknown
): Required<NativeChatAppearanceSettings> {
  const normalized = normalizeNativeChatAppearanceSettings(value)
  return {
    fontFamily: normalized?.fontFamily ?? '',
    fontSize: normalized?.fontSize ?? DEFAULT_NATIVE_CHAT_FONT_SIZE,
    codeFontSize: normalized?.codeFontSize ?? DEFAULT_NATIVE_CHAT_CODE_FONT_SIZE,
    width: normalized?.width ?? 'comfortable',
    contrast: normalized?.contrast ?? DEFAULT_NATIVE_CHAT_CONTRAST,
    matchTerminalInterface: normalized?.matchTerminalInterface ?? false
  }
}

export function resetNativeChatAppearanceSettings(
  appearance: NativeChatAppearanceSettings | undefined
): NativeChatAppearanceSettings | undefined {
  return normalizeNativeChatAppearanceSettings(
    Object.fromEntries(
      Object.entries(appearance ?? {}).filter(
        ([key]) =>
          ![
            'fontFamily',
            'fontSize',
            'codeFontSize',
            'width',
            'contrast',
            'matchTerminalInterface'
          ].includes(key)
      )
    )
  )
}
