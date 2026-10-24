import { z } from 'zod'
import {
  pluginCommandIdSchema,
  pluginIdSchema,
  pluginRelativePathSchema
} from './plugin-manifest-fields'
import { normalizeKeybinding } from '../keybindings'
import { pluginCommandContextSchema } from './plugin-command-contribution'
import {
  pluginFieldDoc,
  pluginPathFieldDoc,
  PLUGIN_MANIFEST_V2_SINCE,
  PLUGIN_SCHEMA_SINCE_V1
} from './plugin-schema-field-docs'

export const PLUGIN_LANGUAGE_PACK_LIMIT = 16
export const PLUGIN_KEYBINDING_LIMIT = 256
export const PLUGIN_VM_RECIPE_LIMIT = 64
export const PLUGIN_AGENT_PROFILE_LIMIT = 64
export const PLUGIN_THEME_LIMIT = 64
export const PLUGIN_TERMINAL_THEME_LIMIT = 64
export const PLUGIN_ICON_THEME_LIMIT = 32
export const PLUGIN_SYNTAX_LIMIT = 16

// Why: locale ids become i18next bundle keys and filenames. This bounded BCP
// 47 subset covers current community packs without accepting path syntax.
export const pluginLocaleIdSchema = z
  .string()
  .min(2)
  .max(35)
  .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, 'must be a portable locale identifier')

export const pluginLanguagePackContributionSchema = z
  .object({
    locale: pluginLocaleIdSchema.meta(
      pluginFieldDoc(
        'BCP 47 locale the pack translates Orca into. Each locale appears once, ignoring case.',
        PLUGIN_SCHEMA_SINCE_V1,
        ['pt-BR']
      )
    ),
    path: pluginRelativePathSchema.meta(
      pluginPathFieldDoc('JSON file of translated interface strings.', PLUGIN_SCHEMA_SINCE_V1, [
        'locales/pt-BR.json'
      ])
    )
  })
  .strict()
  .meta({ id: 'LanguagePackContribution', description: 'An interface translation.' })

export const pluginKeybindingContributionSchema = z
  .object({
    command: pluginCommandIdSchema.meta(
      pluginFieldDoc(
        'Id of a command this plugin contributes in `contributes.commands`.',
        PLUGIN_SCHEMA_SINCE_V1,
        ['jupyter.restartKernel']
      )
    ),
    key: z
      .string()
      .min(1)
      .max(128)
      .meta(
        pluginFieldDoc(
          'Key chord Orca recognizes, such as `Mod+Shift+K`. `Mod` is Cmd on macOS and Ctrl elsewhere. Each chord may be bound once on every platform.',
          PLUGIN_SCHEMA_SINCE_V1,
          ['Mod+Shift+K']
        )
      )
      .transform((value, ctx) => {
        const normalized = normalizeKeybinding(value)
        if (!normalized.ok) {
          ctx.addIssue({ code: 'custom', message: normalized.error })
          return z.NEVER
        }
        return normalized.value
      }),
    when: pluginCommandContextSchema
      .optional()
      .meta(
        pluginFieldDoc(
          "Where the shortcut is active; must match its command's `context`.",
          PLUGIN_SCHEMA_SINCE_V1
        )
      )
  })
  .strict()
  .meta({ id: 'KeybindingContribution', description: 'A keyboard shortcut for a command.' })

export const pluginVmRecipeContributionSchema = z
  .object({
    path: pluginRelativePathSchema.meta(
      pluginPathFieldDoc('JSON environment recipe file, listed once.', PLUGIN_SCHEMA_SINCE_V1, [
        'recipes/ubuntu.json'
      ])
    )
  })
  .strict()
  .meta({ id: 'VmRecipeContribution', description: 'A virtual machine environment recipe.' })

export const pluginAgentProfileContributionSchema = z
  .object({
    path: pluginRelativePathSchema.meta(
      pluginPathFieldDoc('JSON agent profile file, listed once.', PLUGIN_SCHEMA_SINCE_V1, [
        'agents/reviewer.json'
      ])
    )
  })
  .strict()
  .meta({
    id: 'AgentProfileContribution',
    description:
      'Reserved for coding-agent definitions. Manifest format 2 refuses a non-empty `agents` list until their format is defined.'
  })

/** App, terminal and icon themes share one shape: a labelled JSON artifact. */
export const pluginThemeContributionSchema = z
  .object({
    id: pluginIdSchema.meta(
      pluginFieldDoc(
        'Theme id, unique within its family in this plugin. The reserved names `constructor` and `prototype` are refused.',
        PLUGIN_MANIFEST_V2_SINCE,
        ['dusk']
      )
    ),
    label: z
      .string()
      .min(1)
      .max(128)
      .meta(pluginFieldDoc('Name shown in the theme picker.', PLUGIN_MANIFEST_V2_SINCE, ['Dusk'])),
    path: pluginRelativePathSchema.meta(
      pluginPathFieldDoc('JSON theme file, at most 16 KiB.', PLUGIN_MANIFEST_V2_SINCE, [
        'themes/dusk.json'
      ])
    )
  })
  .strict()
  .meta({ id: 'ThemeContribution', description: 'A labelled theme file.' })

export const pluginGrammarScopeSchema = z
  .string()
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+$/, 'must be a TextMate scope name')

/** One highlighted language: the files it claims and its TextMate grammar. */
export const pluginSyntaxContributionSchema = z
  .object({
    id: pluginIdSchema.meta(
      pluginFieldDoc(
        "Language id, unique among this plugin's syntaxes. The reserved names `constructor` and `prototype` are refused.",
        PLUGIN_MANIFEST_V2_SINCE,
        ['gleam']
      )
    ),
    label: z
      .string()
      .min(1)
      .max(128)
      .meta(
        pluginFieldDoc('Language name shown in the editor.', PLUGIN_MANIFEST_V2_SINCE, ['Gleam'])
      ),
    scopeName: pluginGrammarScopeSchema.meta(
      pluginFieldDoc(
        "The grammar's root TextMate scope, unique among this plugin's syntaxes.",
        PLUGIN_MANIFEST_V2_SINCE,
        ['source.gleam']
      )
    ),
    path: pluginRelativePathSchema.meta(
      pluginPathFieldDoc('TextMate grammar JSON file.', PLUGIN_MANIFEST_V2_SINCE, [
        'syntaxes/gleam.tmLanguage.json'
      ])
    ),
    configuration: pluginRelativePathSchema
      .optional()
      .meta(
        pluginPathFieldDoc(
          'Language configuration JSON file: comments, brackets and auto-closing pairs.',
          PLUGIN_MANIFEST_V2_SINCE,
          ['syntaxes/language-configuration.json']
        )
      ),
    extensions: z
      .array(
        z
          .string()
          .max(64)
          .regex(/^\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/, 'must look like .ext')
      )
      .max(32)
      .default([])
      .meta(
        pluginFieldDoc(
          'File extensions this language opens, with the dot.',
          PLUGIN_MANIFEST_V2_SINCE,
          [['.gleam']]
        )
      ),
    filenames: z
      .array(
        z
          .string()
          .min(1)
          .max(128)
          .refine(
            (name) =>
              name !== '.' &&
              name !== '..' &&
              !/[<>:"/\\|?*]/.test(name) &&
              Array.from(name).every((character) => character.charCodeAt(0) >= 32),
            'must be a portable file name'
          )
      )
      .max(32)
      .default([])
      .meta(
        pluginFieldDoc(
          'Exact file names this language opens. Names must be portable: no path separators, `.`, `..` or characters Windows forbids.',
          PLUGIN_MANIFEST_V2_SINCE,
          [['gleam.toml']]
        )
      )
  })
  .strict()
  .meta({ id: 'SyntaxContribution', description: 'Syntax highlighting for one language.' })

export type PluginLanguagePackContribution = z.infer<typeof pluginLanguagePackContributionSchema>
export type PluginKeybindingContribution = z.infer<typeof pluginKeybindingContributionSchema>
export type PluginVmRecipeContribution = z.infer<typeof pluginVmRecipeContributionSchema>
export type PluginAgentProfileContribution = z.infer<typeof pluginAgentProfileContributionSchema>
export type PluginThemeContribution = z.infer<typeof pluginThemeContributionSchema>
export type PluginSyntaxContribution = z.infer<typeof pluginSyntaxContributionSchema>
