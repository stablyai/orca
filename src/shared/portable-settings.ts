import {
  isKeybindingActionId,
  type KeybindingFileSnapshot,
  type KeybindingOverrides,
  type KeybindingPlatform
} from './keybindings'
import {
  PORTABLE_SETTINGS_VERSION,
  PortableSettingsBundleSchema,
  type PortableSettingsBundle,
  type PortableSettingsCategory
} from './portable-settings-schema'
import type { GlobalSettings } from './types'

export * from './portable-settings-schema'

export function createPortableSettingsBundle(
  settings: GlobalSettings,
  keybindings: Pick<KeybindingFileSnapshot, 'platform' | 'overrides'>
): PortableSettingsBundle {
  return PortableSettingsBundleSchema.parse({
    version: PORTABLE_SETTINGS_VERSION,
    categories: {
      appearance: {
        theme: settings.theme,
        leftSidebarAppearanceMode: settings.leftSidebarAppearanceMode,
        leftSidebarTintColor: settings.leftSidebarTintColor,
        leftSidebarTintOpacity: settings.leftSidebarTintOpacity,
        appFontFamily: settings.appFontFamily,
        terminalFontSize: settings.terminalFontSize,
        terminalFontFamily: settings.terminalFontFamily,
        terminalFontWeight: settings.terminalFontWeight,
        terminalLineHeight: settings.terminalLineHeight,
        terminalGpuAcceleration: settings.terminalGpuAcceleration,
        terminalLigatures: settings.terminalLigatures,
        terminalCursorStyle: settings.terminalCursorStyle,
        terminalCursorBlink: settings.terminalCursorBlink,
        terminalThemeDark: settings.terminalThemeDark,
        terminalCustomThemes: settings.terminalCustomThemes?.map(
          ({ sourceLabel: _sourceLabel, ...theme }) => theme
        ),
        terminalDividerColorDark: settings.terminalDividerColorDark,
        terminalUseSeparateLightTheme: settings.terminalUseSeparateLightTheme,
        terminalThemeLight: settings.terminalThemeLight,
        terminalDividerColorLight: settings.terminalDividerColorLight,
        terminalInactivePaneOpacity: settings.terminalInactivePaneOpacity,
        terminalActivePaneOpacity: settings.terminalActivePaneOpacity,
        terminalPaneOpacityTransitionMs: settings.terminalPaneOpacityTransitionMs,
        terminalDividerThicknessPx: settings.terminalDividerThicknessPx,
        terminalBackgroundOpacity: settings.terminalBackgroundOpacity,
        terminalColorOverrides: settings.terminalColorOverrides,
        terminalPaddingX: settings.terminalPaddingX,
        terminalPaddingY: settings.terminalPaddingY,
        terminalCursorOpacity: settings.terminalCursorOpacity,
        windowBackgroundBlur: settings.windowBackgroundBlur,
        diffDefaultView: settings.diffDefaultView,
        diffWordWrap: settings.diffWordWrap,
        combinedDiffFileTreeVisibleByDefault: settings.combinedDiffFileTreeVisibleByDefault,
        compactWorktreeCards: settings.compactWorktreeCards
      },
      input: {
        editorAutoSave: settings.editorAutoSave,
        editorAutoSaveDelayMs: settings.editorAutoSaveDelayMs,
        editorMinimapEnabled: settings.editorMinimapEnabled,
        editorWordWrap: settings.editorWordWrap,
        richMarkdownSpellcheckEnabled: settings.richMarkdownSpellcheckEnabled,
        markdownReviewToolsEnabled: settings.markdownReviewToolsEnabled,
        primarySelectionMiddleClickPaste: settings.primarySelectionMiddleClickPaste,
        terminalScrollSensitivity: settings.terminalScrollSensitivity,
        terminalFastScrollSensitivity: settings.terminalFastScrollSensitivity,
        terminalTuiScrollSensitivity: settings.terminalTuiScrollSensitivity,
        terminalFocusFollowsMouse: settings.terminalFocusFollowsMouse,
        terminalClipboardOnSelect: settings.terminalClipboardOnSelect,
        terminalMouseHideWhileTyping: settings.terminalMouseHideWhileTyping,
        terminalWordSeparator: settings.terminalWordSeparator,
        terminalRightClickToPaste: settings.terminalRightClickToPaste,
        terminalShortcutPolicy: settings.terminalShortcutPolicy,
        terminalScopeHistoryByWorktree: settings.terminalScopeHistoryByWorktree,
        keybindings: {
          sourcePlatform: keybindings.platform,
          overrides: keybindings.overrides
        }
      },
      workflow: {
        refreshLocalBaseRefOnWorktreeCreate: settings.refreshLocalBaseRefOnWorktreeCreate,
        autoRenameBranchFromWork: settings.autoRenameBranchFromWork,
        branchPrefix: settings.branchPrefix,
        branchPrefixCustom: settings.branchPrefixCustom,
        enableGitHubAttribution: settings.enableGitHubAttribution,
        setupScriptLaunchMode: settings.setupScriptLaunchMode,
        openLinksInApp: settings.openLinksInApp,
        localhostWorktreeLabelsEnabled: settings.localhostWorktreeLabelsEnabled,
        openAgentTabsInChatByDefault: settings.openAgentTabsInChatByDefault,
        sourceControlViewMode: settings.sourceControlViewMode,
        sourceControlGroupOrder: settings.sourceControlGroupOrder,
        sourceControlCompareAgainstUpstream: settings.sourceControlCompareAgainstUpstream,
        ctrlTabOrderMode: settings.ctrlTabOrderMode,
        defaultTuiAgent: settings.defaultTuiAgent,
        disabledTuiAgents: settings.disabledTuiAgents,
        tabAutoGenerateTitle: settings.tabAutoGenerateTitle,
        confirmClosePinnedTab: settings.confirmClosePinnedTab,
        promptCacheTimerEnabled: settings.promptCacheTimerEnabled,
        promptCacheTtlMs: settings.promptCacheTtlMs,
        defaultTaskSource: settings.defaultTaskSource,
        defaultTaskViewPreset: settings.defaultTaskViewPreset,
        visibleTaskProviders: settings.visibleTaskProviders
      }
    }
  })
}

export function getPortableSettingsCategoryDifferences(
  source: PortableSettingsBundle,
  target: PortableSettingsBundle,
  category: PortableSettingsCategory
): string[] {
  const sourceCategory = source.categories[category] as Record<string, unknown>
  const targetCategory = target.categories[category] as Record<string, unknown>
  return Object.keys(sourceCategory).filter((key) => {
    if (category === 'input' && key === 'keybindings') {
      const sourceKeybindings = source.categories.input.keybindings
      const targetKeybindings = target.categories.input.keybindings
      const mappedSource = remapPortableKeybindingOverrides(
        sourceKeybindings.overrides,
        sourceKeybindings.sourcePlatform,
        targetKeybindings.sourcePlatform
      )
      return stableJson(mappedSource) !== stableJson(targetKeybindings.overrides)
    }
    return stableJson(sourceCategory[key]) !== stableJson(targetCategory[key])
  })
}

export function remapPortableKeybindingOverrides(
  overrides: Record<string, string[]>,
  sourcePlatform: KeybindingPlatform,
  targetPlatform: KeybindingPlatform
): KeybindingOverrides {
  const mapped: KeybindingOverrides = {}
  for (const [actionId, bindings] of Object.entries(overrides)) {
    if (!isKeybindingActionId(actionId)) {
      continue
    }
    mapped[actionId] = bindings.map((binding) =>
      remapPortableKeybinding(binding, sourcePlatform, targetPlatform)
    )
  }
  return mapped
}

function remapPortableKeybinding(
  binding: string,
  sourcePlatform: KeybindingPlatform,
  targetPlatform: KeybindingPlatform
): string {
  if (
    sourcePlatform === targetPlatform ||
    (sourcePlatform !== 'darwin' && targetPlatform !== 'darwin')
  ) {
    return binding
  }
  const sourcePrimary = sourcePlatform === 'darwin' ? 'Cmd' : 'Ctrl'
  const targetPrimary = targetPlatform === 'darwin' ? 'Cmd' : 'Ctrl'
  return binding
    .split('+')
    .map((token) => (token === sourcePrimary ? targetPrimary : token))
    .join('+')
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson)
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJson(nested)])
  )
}
