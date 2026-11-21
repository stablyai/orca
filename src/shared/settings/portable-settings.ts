import type { GlobalSettings } from './global-settings-types'

export const PORTABLE_SETTINGS_FORMAT = 'orca-settings'
export const PORTABLE_SETTINGS_VERSION = 1

type PortableValueRule =
  | { kind: 'boolean' }
  | { kind: 'number' }
  | { kind: 'string'; oneOf?: readonly string[] }
  | { kind: 'string-array' }
  | { kind: 'array' }
  | { kind: 'object' }

const BOOLEAN = { kind: 'boolean' } as const
const NUMBER = { kind: 'number' } as const
const STRING = { kind: 'string' } as const
const STRING_ARRAY = { kind: 'string-array' } as const
const ARRAY = { kind: 'array' } as const
const OBJECT = { kind: 'object' } as const
const FONT_LIGATURES = { kind: 'string', oneOf: ['auto', 'on', 'off'] } as const

// Allowlist, not denylist: a new setting stays on its machine until someone decides it is portable.
// Left out on purpose: accounts, tokens and cookies, absolute paths, proxies, per-OS and per-GPU
// choices, telemetry, pairing, one-shot migration guards, plugin grants, and agent env (may hold secrets).
export const PORTABLE_SETTING_RULES = {
  theme: { kind: 'string', oneOf: ['system', 'dark', 'light'] },
  uiLanguage: STRING,
  appFontFamily: STRING,
  leftSidebarAppearanceMode: STRING,
  leftSidebarTintColor: STRING,
  leftSidebarTintOpacity: NUMBER,
  windowMaterial: { kind: 'string', oneOf: ['off', 'translucent', 'blur'] },
  reduceVisualEffects: BOOLEAN,
  showTitlebarAppName: BOOLEAN,
  showTasksButton: BOOLEAN,
  showAutomationsButton: BOOLEAN,
  showArtifactsButton: BOOLEAN,
  showSkillsButton: BOOLEAN,
  showMobileButton: BOOLEAN,
  showPinnedWorktreesInGroups: BOOLEAN,
  compactWorktreeCards: BOOLEAN,
  worktreeCardDetailsRow: BOOLEAN,
  ctrlTabOrderMode: STRING,
  confirmClosePinnedTab: BOOLEAN,
  tabAutoGenerateTitle: BOOLEAN,

  editorFontFamily: STRING,
  editorFontSize: NUMBER,
  editorFontWeight: NUMBER,
  editorLineHeight: NUMBER,
  editorLigatures: FONT_LIGATURES,
  codeFontSmoothing: { kind: 'string', oneOf: ['grayscale', 'native'] },
  editorAutoSave: BOOLEAN,
  editorAutoSaveDelayMs: NUMBER,
  editorMinimapEnabled: BOOLEAN,
  editorInlineBlame: BOOLEAN,
  editorWordWrap: BOOLEAN,
  editorFormatOnSave: BOOLEAN,
  editorInsertFinalNewline: BOOLEAN,
  editorEndOfLine: STRING,
  editorPreviewTabsEnabled: BOOLEAN,
  richMarkdownSpellcheckEnabled: BOOLEAN,
  markdownDefaultViewMode: { kind: 'string', oneOf: ['source', 'rich'] },
  markdownReviewToolsEnabled: BOOLEAN,

  terminalFontSize: NUMBER,
  terminalFontFamily: STRING,
  terminalFontWeight: NUMBER,
  terminalFontWeightBold: NUMBER,
  terminalLineHeight: NUMBER,
  terminalLigatures: FONT_LIGATURES,
  terminalCursorStyle: { kind: 'string', oneOf: ['bar', 'block', 'underline'] },
  terminalCursorBlink: BOOLEAN,
  terminalCursorOpacity: NUMBER,
  terminalThemeDark: STRING,
  terminalThemeLight: STRING,
  terminalUseSeparateLightTheme: BOOLEAN,
  terminalCustomThemes: ARRAY,
  terminalColorOverrides: OBJECT,
  terminalColorOverridesLight: OBJECT,
  terminalColorOverridesSplit: BOOLEAN,
  terminalDividerColorDark: STRING,
  terminalDividerColorLight: STRING,
  terminalDividerThicknessPx: NUMBER,
  terminalInactivePaneOpacity: NUMBER,
  terminalActivePaneOpacity: NUMBER,
  terminalPaneOpacityTransitionMs: NUMBER,
  terminalBackgroundOpacity: NUMBER,
  terminalMinimumContrastRatio: NUMBER,
  terminalPaddingX: NUMBER,
  terminalPaddingY: NUMBER,
  terminalInlineImages: BOOLEAN,
  terminalScrollSensitivity: NUMBER,
  terminalFastScrollSensitivity: NUMBER,
  terminalTuiScrollSensitivity: NUMBER,
  terminalScrollbackRows: NUMBER,
  terminalScrollOnUserInput: BOOLEAN,
  terminalMouseHideWhileTyping: BOOLEAN,
  terminalWordSeparator: STRING,
  terminalFocusFollowsMouse: BOOLEAN,
  terminalClipboardOnSelect: BOOLEAN,
  terminalCopyTrimsGutter: BOOLEAN,
  terminalLinkClickBehavior: { kind: 'string', oneOf: ['actions', 'open', 'none'] },
  terminalUrlMiddleClickBehavior: { kind: 'string', oneOf: ['open', 'actions', 'none'] },
  terminalScopeHistoryByWorktree: BOOLEAN,
  terminalShortcutPolicy: { kind: 'string', oneOf: ['orca-first', 'terminal-first'] },
  terminalQuickCommands: ARRAY,

  diffDefaultView: { kind: 'string', oneOf: ['inline', 'side-by-side'] },
  diffWordWrap: BOOLEAN,
  diffShowWhitespace: BOOLEAN,
  diffCollapseUnchangedRegions: BOOLEAN,
  combinedDiffFileTreeVisibleByDefault: BOOLEAN,
  sourceControlViewMode: STRING,
  sourceControlGroupOrder: STRING,
  sourceControlCompareAgainstUpstream: BOOLEAN,
  prAutoRefresh: STRING,
  branchPrefix: STRING,
  branchPrefixCustom: STRING,
  autoRenameBranchFromWork: BOOLEAN,
  refreshLocalBaseRefOnWorktreeCreate: BOOLEAN,
  jiraIssueKeyCasing: STRING,

  defaultTuiAgent: STRING,
  disabledTuiAgents: STRING_ARRAY,
  agentDefaultArgs: OBJECT,
  promptCacheTimerEnabled: BOOLEAN,
  promptCacheTtlMs: NUMBER,
  defaultTaskViewPreset: STRING,
  visibleTaskProviders: STRING_ARRAY,
  skipCloseTerminalWithRunningProcessConfirm: BOOLEAN,
  skipDeleteAutomationConfirm: BOOLEAN,
  skipDeleteArtifactConfirm: BOOLEAN
} as const satisfies Partial<Record<keyof GlobalSettings, PortableValueRule>>

export type PortableSettingKey = keyof typeof PORTABLE_SETTING_RULES
export type PortableSettings = Partial<Pick<GlobalSettings, PortableSettingKey>>

export type PortableSettingsFile = {
  format: typeof PORTABLE_SETTINGS_FORMAT
  version: typeof PORTABLE_SETTINGS_VERSION
  exportedAt: string
  settings: PortableSettings
}

type PortableSettingsParseFailure = 'invalid-json' | 'not-orca-settings' | 'unsupported-version'

export type PortableSettingsParseResult =
  | { ok: true; settings: PortableSettings; ignoredKeys: string[] }
  | { ok: false; reason: PortableSettingsParseFailure }

export type SettingsExportResult =
  | { status: 'saved'; filePath: string; settingCount: number }
  | { status: 'cancelled' }
  | { status: 'failed' }

export type SettingsImportReadResult =
  | { status: 'loaded'; settings: PortableSettings; ignoredKeys: string[] }
  | { status: 'cancelled' }
  | { status: 'failed'; reason: PortableSettingsParseFailure | 'unreadable' | 'too-large' }

function isPortableSettingKey(key: string): key is PortableSettingKey {
  return Object.hasOwn(PORTABLE_SETTING_RULES, key)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function matchesRule(rule: PortableValueRule, value: unknown): boolean {
  switch (rule.kind) {
    case 'boolean':
      return typeof value === 'boolean'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'string':
      return typeof value === 'string' && (!rule.oneOf || rule.oneOf.includes(value))
    case 'string-array':
      return Array.isArray(value) && value.every((item) => typeof item === 'string')
    case 'array':
      return Array.isArray(value)
    case 'object':
      return isPlainObject(value)
  }
}

export function buildPortableSettingsFile(
  settings: GlobalSettings,
  exportedAt: Date
): PortableSettingsFile {
  const portable: Record<string, unknown> = {}
  for (const key of Object.keys(PORTABLE_SETTING_RULES)) {
    if (!isPortableSettingKey(key)) {
      continue
    }
    const value = settings[key]
    // Unset optional settings stay unset so the importing machine keeps its own default.
    if (value !== undefined && matchesRule(PORTABLE_SETTING_RULES[key], value)) {
      portable[key] = value
    }
  }
  return {
    format: PORTABLE_SETTINGS_FORMAT,
    version: PORTABLE_SETTINGS_VERSION,
    exportedAt: exportedAt.toISOString(),
    settings: portable
  }
}

export function parsePortableSettingsFile(text: string): PortableSettingsParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'invalid-json' }
  }
  if (
    !isPlainObject(parsed) ||
    parsed.format !== PORTABLE_SETTINGS_FORMAT ||
    !isPlainObject(parsed.settings)
  ) {
    return { ok: false, reason: 'not-orca-settings' }
  }
  if (parsed.version !== PORTABLE_SETTINGS_VERSION) {
    return { ok: false, reason: 'unsupported-version' }
  }
  const settings: Record<string, unknown> = {}
  const ignoredKeys: string[] = []
  for (const [key, value] of Object.entries(parsed.settings)) {
    if (isPortableSettingKey(key) && matchesRule(PORTABLE_SETTING_RULES[key], value)) {
      settings[key] = value
    } else {
      ignoredKeys.push(key)
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every kept key passed its rule above.
  return { ok: true, settings: settings as PortableSettings, ignoredKeys }
}
