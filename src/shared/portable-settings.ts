import { z } from 'zod'
import { MAX_EDITOR_AUTO_SAVE_DELAY_MS, MIN_EDITOR_AUTO_SAVE_DELAY_MS } from './constants'
import {
  EDITOR_FONT_SIZE_MAX,
  EDITOR_FONT_SIZE_MIN,
  EDITOR_LINE_HEIGHT_MAX,
  EDITOR_LINE_HEIGHT_MIN
} from './editor/editor-typography'
import type { GlobalSettings } from './global-settings-types'
import {
  MAX_TERMINAL_LINE_HEIGHT,
  MIN_TERMINAL_LINE_HEIGHT
} from './terminal/appearance/terminal-line-height-settings'
import {
  TERMINAL_FONT_WEIGHT_MAX,
  TERMINAL_FONT_WEIGHT_MIN
} from './terminal/appearance/terminal-fonts'
import { normalizeUiLanguage, type UiLanguage } from './ui-language'

const flag = z.boolean()
const name = z.string().max(256)
const fraction = z.number().min(0).max(1)
const fontWeight = z.number().int().min(TERMINAL_FONT_WEIGHT_MIN).max(TERMINAL_FONT_WEIGHT_MAX)

// Preferences that mean the same on any computer. Everything else stays where it was set: paths,
// accounts, secrets, the machine name, plugin approvals, agent launch flags and platform options.
const PORTABLE_SETTING_SCHEMAS = {
  theme: z.enum(['system', 'dark', 'light']),
  uiLanguage: z.custom<UiLanguage>((value) => normalizeUiLanguage(value) === value),
  appFontFamily: name,
  showTitlebarAppName: flag,
  showTasksButton: flag,
  showAutomationsButton: flag,
  showArtifactsButton: flag,
  showSkillsButton: flag,
  showMobileButton: flag,
  showPinnedWorktreesInGroups: flag,
  rightSidebarOpenByDefault: flag,
  compactWorktreeCards: flag,
  terminalFontFamily: name,
  terminalFontSize: z.number().int().positive(),
  terminalFontWeight: fontWeight,
  terminalFontWeightBold: fontWeight,
  terminalLineHeight: z.number().min(MIN_TERMINAL_LINE_HEIGHT).max(MAX_TERMINAL_LINE_HEIGHT),
  terminalLigatures: z.enum(['auto', 'on', 'off']),
  terminalCursorStyle: z.enum(['bar', 'block', 'underline']),
  terminalCursorBlink: flag,
  terminalThemeDark: name,
  terminalThemeLight: name,
  terminalUseSeparateLightTheme: flag,
  terminalDividerColorDark: name,
  terminalDividerColorLight: name,
  terminalInactivePaneOpacity: fraction,
  terminalActivePaneOpacity: fraction,
  terminalFocusFollowsMouse: flag,
  terminalClipboardOnSelect: flag,
  terminalCopyTrimsGutter: flag,
  terminalMouseHideWhileTyping: flag,
  terminalLinkClickBehavior: z.enum(['actions', 'open', 'none']),
  terminalUrlMiddleClickBehavior: z.enum(['open', 'actions', 'none']),
  editorAutoSave: flag,
  editorAutoSaveDelayMs: z
    .number()
    .int()
    .min(MIN_EDITOR_AUTO_SAVE_DELAY_MS)
    .max(MAX_EDITOR_AUTO_SAVE_DELAY_MS),
  editorMinimapEnabled: flag,
  editorWordWrap: flag,
  editorPreviewTabsEnabled: flag,
  editorFontFamily: name,
  editorFontSize: z.number().min(EDITOR_FONT_SIZE_MIN).max(EDITOR_FONT_SIZE_MAX),
  editorFontWeight: fontWeight,
  editorLineHeight: z.number().min(EDITOR_LINE_HEIGHT_MIN).max(EDITOR_LINE_HEIGHT_MAX),
  markdownDefaultViewMode: z.enum(['source', 'rich']),
  markdownReviewToolsEnabled: flag,
  richMarkdownSpellcheckEnabled: flag,
  diffDefaultView: z.enum(['inline', 'side-by-side']),
  diffWordWrap: flag,
  diffShowWhitespace: flag,
  diffCollapseUnchangedRegions: flag,
  combinedDiffFileTreeVisibleByDefault: flag,
  branchPrefix: z.enum(['git-username', 'custom', 'none']),
  branchPrefixCustom: name,
  autoRenameBranchFromWork: flag,
  refreshLocalBaseRefOnWorktreeCreate: flag,
  jiraIssueKeyCasing: z.enum(['lowercase', 'preserve']),
  sourceControlViewMode: z.enum(['list', 'tree']),
  sourceControlGroupOrder: z.enum(['changes-first', 'staged-first', 'untracked-first']),
  sourceControlCompareAgainstUpstream: flag,
  tabAutoGenerateTitle: flag,
  confirmClosePinnedTab: flag,
  skipCloseTerminalWithRunningProcessConfirm: flag,
  skipDeleteAutomationConfirm: flag,
  skipDeleteArtifactConfirm: flag,
  openLinksInApp: flag,
  openLinksInAppModifierInverts: flag
} satisfies { [K in keyof GlobalSettings]?: z.ZodType<NonNullable<GlobalSettings[K]>> }

export type PortableSettingKey = keyof typeof PORTABLE_SETTING_SCHEMAS
export type PortableSettings = Partial<Pick<GlobalSettings, PortableSettingKey>>
/** A settings store's values as read, before the schema checks them. */
export type StoredPortableSettings = Partial<Record<PortableSettingKey, unknown>>

export type PortableSettingsImportResult = {
  /** Settings the receiving Orca changed (or would change, in a dry run). */
  changed: string[]
  /** Settings the receiving Orca does not copy or whose values it refused. */
  skipped: string[]
}

function isPortableSettingKey(key: string): key is PortableSettingKey {
  return Object.hasOwn(PORTABLE_SETTING_SCHEMAS, key)
}

const PORTABLE_SETTING_KEYS = Object.keys(PORTABLE_SETTING_SCHEMAS).filter(isPortableSettingKey)

function copySetting<K extends PortableSettingKey>(
  target: PortableSettings,
  key: K,
  value: PortableSettings[K]
): void {
  target[key] = value
}

/** This Orca's own portable settings, minus any stored value the schema refuses. */
export function pickPortableSettings(settings: StoredPortableSettings): PortableSettings {
  return readPortableSettings(
    Object.fromEntries(
      PORTABLE_SETTING_KEYS.filter((key) => settings[key] !== undefined).map((key) => [
        key,
        settings[key]
      ])
    )
  ).settings
}

/** Keeps what this Orca copies; a newer sender's other settings and values come back as skipped. */
export function readPortableSettings(input: Record<string, unknown>): {
  settings: PortableSettings
  skipped: string[]
} {
  const settings: PortableSettings = {}
  const skipped: string[] = []
  for (const [key, value] of Object.entries(input)) {
    if (!isPortableSettingKey(key)) {
      skipped.push(key)
      continue
    }
    const parsed = PORTABLE_SETTING_SCHEMAS[key].safeParse(value)
    if (parsed.success) {
      copySetting(settings, key, parsed.data)
    } else {
      skipped.push(key)
    }
  }
  return { settings, skipped }
}

export function portableSettingChanges(
  current: PortableSettings,
  incoming: PortableSettings
): PortableSettings {
  const changes: PortableSettings = {}
  for (const key of PORTABLE_SETTING_KEYS) {
    if (incoming[key] !== undefined && incoming[key] !== current[key]) {
      copySetting(changes, key, incoming[key])
    }
  }
  return changes
}
