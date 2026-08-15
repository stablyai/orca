import { z } from 'zod'
import { isKeybindingActionId } from './keybindings'
import { isTuiAgent } from './tui-agent-config'
import { isTaskProvider } from './task-providers'
import type { GlobalSettings, TaskProvider } from './types'

export const PORTABLE_SETTINGS_VERSION = 1 as const
export const PORTABLE_SETTINGS_CATEGORIES = ['appearance', 'input', 'workflow'] as const
export type PortableSettingsCategory = (typeof PORTABLE_SETTINGS_CATEGORIES)[number]

const finiteNumber = z.number().finite()
const boundedString = z.string().max(512)
const optionalUnitInterval = finiteNumber.min(0).max(1).optional()
const TerminalColorsSchema = z
  .object({
    foreground: z.string().max(32).optional(),
    background: z.string().max(32).optional(),
    cursor: z.string().max(32).optional(),
    cursorAccent: z.string().max(32).optional(),
    selectionBackground: z.string().max(32).optional(),
    selectionForeground: z.string().max(32).optional(),
    black: z.string().max(32).optional(),
    red: z.string().max(32).optional(),
    green: z.string().max(32).optional(),
    yellow: z.string().max(32).optional(),
    blue: z.string().max(32).optional(),
    magenta: z.string().max(32).optional(),
    cyan: z.string().max(32).optional(),
    white: z.string().max(32).optional(),
    brightBlack: z.string().max(32).optional(),
    brightRed: z.string().max(32).optional(),
    brightGreen: z.string().max(32).optional(),
    brightYellow: z.string().max(32).optional(),
    brightBlue: z.string().max(32).optional(),
    brightMagenta: z.string().max(32).optional(),
    brightCyan: z.string().max(32).optional(),
    brightWhite: z.string().max(32).optional(),
    bold: z.string().max(32).optional()
  })
  .strict()
const PortableTerminalThemeSchema = z
  .object({
    id: z.string().max(128),
    name: z.string().max(128),
    source: z.enum(['warp', 'ghostty', 'manual']),
    mode: z.enum(['dark', 'light', 'unknown']),
    terminal: TerminalColorsSchema,
    importedAt: z.string().max(64),
    unsupportedFeatures: z.array(z.string().max(256)).max(64).optional()
  })
  .strict()

export const PortableAppearanceSettingsSchema = z
  .object({
    theme: z.enum(['system', 'dark', 'light']),
    leftSidebarAppearanceMode: z.enum(['default', 'match-terminal', 'tinted']),
    leftSidebarTintColor: z.string().max(32).optional(),
    leftSidebarTintOpacity: optionalUnitInterval,
    appFontFamily: boundedString,
    terminalFontSize: finiteNumber.min(6).max(96),
    terminalFontFamily: boundedString,
    terminalFontWeight: finiteNumber.min(100).max(1000),
    terminalLineHeight: finiteNumber.min(0.5).max(4),
    terminalGpuAcceleration: z.enum(['auto', 'on', 'off']),
    terminalLigatures: z.enum(['auto', 'on', 'off']),
    terminalCursorStyle: z.enum(['bar', 'block', 'underline']),
    terminalCursorBlink: z.boolean(),
    terminalThemeDark: boundedString,
    terminalCustomThemes: z.array(PortableTerminalThemeSchema).max(200).optional(),
    terminalDividerColorDark: z.string().max(32),
    terminalUseSeparateLightTheme: z.boolean(),
    terminalThemeLight: boundedString,
    terminalDividerColorLight: z.string().max(32),
    terminalInactivePaneOpacity: finiteNumber.min(0).max(1),
    terminalActivePaneOpacity: finiteNumber.min(0).max(1),
    terminalPaneOpacityTransitionMs: finiteNumber.min(0).max(10_000),
    terminalDividerThicknessPx: finiteNumber.min(0).max(20),
    terminalBackgroundOpacity: optionalUnitInterval,
    terminalColorOverrides: TerminalColorsSchema.optional(),
    terminalPaddingX: finiteNumber.min(0).max(100).optional(),
    terminalPaddingY: finiteNumber.min(0).max(100).optional(),
    terminalCursorOpacity: optionalUnitInterval,
    windowBackgroundBlur: z.boolean().optional(),
    diffDefaultView: z.enum(['inline', 'side-by-side']),
    diffWordWrap: z.boolean(),
    combinedDiffFileTreeVisibleByDefault: z.boolean(),
    compactWorktreeCards: z.boolean()
  })
  .strict()

const RawKeybindingOverridesSchema = z
  .record(z.string(), z.array(z.string().max(128)).max(8))
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > 256) {
      ctx.addIssue({ code: 'custom', message: 'Too many keybinding overrides.' })
    }
    for (const actionId of Object.keys(value)) {
      if (!isKeybindingActionId(actionId)) {
        ctx.addIssue({ code: 'custom', message: `Unknown keybinding action: ${actionId}` })
      }
    }
  })

export const PortableInputSettingsSchema = z
  .object({
    editorAutoSave: z.boolean(),
    editorAutoSaveDelayMs: finiteNumber.min(0).max(60_000),
    editorMinimapEnabled: z.boolean(),
    editorWordWrap: z.boolean().optional(),
    richMarkdownSpellcheckEnabled: z.boolean().optional(),
    markdownReviewToolsEnabled: z.boolean(),
    primarySelectionMiddleClickPaste: z.boolean().optional(),
    terminalScrollSensitivity: finiteNumber.min(0).max(100),
    terminalFastScrollSensitivity: finiteNumber.min(0).max(100),
    terminalTuiScrollSensitivity: finiteNumber.min(0).max(100),
    terminalFocusFollowsMouse: z.boolean(),
    terminalClipboardOnSelect: z.boolean(),
    terminalMouseHideWhileTyping: z.boolean().optional(),
    terminalWordSeparator: z.string().max(512).optional(),
    terminalRightClickToPaste: z.boolean(),
    terminalShortcutPolicy: z.enum(['orca-first', 'terminal-first']).optional(),
    terminalScopeHistoryByWorktree: z.boolean(),
    keybindings: z
      .object({
        sourcePlatform: z.enum(['darwin', 'linux', 'win32']),
        overrides: RawKeybindingOverridesSchema
      })
      .strict()
  })
  .strict()

const TuiAgentSchema = z.custom<NonNullable<GlobalSettings['defaultTuiAgent']>>(isTuiAgent, {
  message: 'Unknown agent'
})
const TaskProviderSchema = z.custom<TaskProvider>(isTaskProvider, {
  message: 'Unknown task provider'
})

export const PortableWorkflowSettingsSchema = z
  .object({
    refreshLocalBaseRefOnWorktreeCreate: z.boolean(),
    autoRenameBranchFromWork: z.boolean(),
    branchPrefix: z.enum(['git-username', 'custom', 'none']),
    branchPrefixCustom: z.string().max(128),
    enableGitHubAttribution: z.boolean(),
    setupScriptLaunchMode: z.enum(['split-vertical', 'split-horizontal', 'new-tab']),
    openLinksInApp: z.boolean(),
    localhostWorktreeLabelsEnabled: z.boolean().optional(),
    openAgentTabsInChatByDefault: z.boolean().optional(),
    sourceControlViewMode: z.enum(['list', 'tree']),
    sourceControlGroupOrder: z.enum(['changes-first', 'staged-first', 'untracked-first']),
    sourceControlCompareAgainstUpstream: z.boolean(),
    ctrlTabOrderMode: z.enum(['mru', 'sequential']).optional(),
    defaultTuiAgent: z.union([TuiAgentSchema, z.literal('blank'), z.null()]),
    disabledTuiAgents: z.array(TuiAgentSchema).max(64),
    tabAutoGenerateTitle: z.boolean(),
    confirmClosePinnedTab: z.boolean(),
    promptCacheTimerEnabled: z.boolean(),
    promptCacheTtlMs: z.union([z.literal(300_000), z.literal(3_600_000)]),
    defaultTaskSource: TaskProviderSchema,
    defaultTaskViewPreset: z.enum(['all', 'issues', 'review', 'my-issues', 'my-prs', 'prs']),
    visibleTaskProviders: z.array(TaskProviderSchema).max(16)
  })
  .strict()

export const PortableSettingsBundleSchema = z
  .object({
    version: z.literal(PORTABLE_SETTINGS_VERSION),
    categories: z
      .object({
        appearance: PortableAppearanceSettingsSchema,
        input: PortableInputSettingsSchema,
        workflow: PortableWorkflowSettingsSchema
      })
      .strict()
  })
  .strict()

export const PortableSettingsApplyRequestSchema = z
  .object({
    categories: z.array(z.enum(PORTABLE_SETTINGS_CATEGORIES)).min(1).max(3),
    bundle: PortableSettingsBundleSchema
  })
  .strict()

export type PortableAppearanceSettings = z.infer<typeof PortableAppearanceSettingsSchema>
export type PortableInputSettings = z.infer<typeof PortableInputSettingsSchema>
export type PortableWorkflowSettings = z.infer<typeof PortableWorkflowSettingsSchema>
export type PortableSettingsBundle = z.infer<typeof PortableSettingsBundleSchema>
export type PortableSettingsApplyRequest = z.infer<typeof PortableSettingsApplyRequestSchema>
