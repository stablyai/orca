import { z } from 'zod'
import { isSafeThemeGradient } from './plugin-theme-gradient-value'
import { pluginIdSchema } from './plugin-manifest-fields'

export const PLUGIN_APP_THEME_COLOR_TOKENS = [
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--popover',
  '--popover-foreground',
  '--primary',
  '--primary-foreground',
  '--secondary',
  '--secondary-foreground',
  '--muted',
  '--muted-foreground',
  '--accent',
  '--accent-foreground',
  '--destructive',
  '--destructive-foreground',
  '--border',
  '--input',
  '--ring',
  '--editor-surface',
  '--settings-canvas',
  '--settings-panel',
  '--settings-panel-border',
  '--chart-1',
  '--chart-2',
  '--chart-3',
  '--chart-4',
  '--chart-5',
  '--sidebar',
  '--sidebar-foreground',
  '--sidebar-primary',
  '--sidebar-primary-foreground',
  '--sidebar-accent',
  '--sidebar-accent-foreground',
  '--sidebar-border',
  '--sidebar-ring',
  '--worktree-sidebar',
  '--worktree-sidebar-foreground',
  '--worktree-sidebar-accent',
  '--worktree-sidebar-accent-foreground',
  '--worktree-sidebar-border',
  '--worktree-sidebar-ring',
  '--right-sidebar',
  '--right-sidebar-foreground',
  '--right-sidebar-accent',
  '--right-sidebar-accent-foreground',
  '--right-sidebar-border',
  '--right-sidebar-ring',
  '--appearance-state-hover',
  '--appearance-state-hover-foreground',
  '--appearance-state-selected',
  '--appearance-state-selected-foreground',
  '--appearance-state-current',
  '--appearance-state-current-foreground',
  '--appearance-state-hover-border',
  '--appearance-state-selected-border',
  '--appearance-state-current-border'
] as const

export const PLUGIN_APP_THEME_LENGTH_TOKENS = [
  '--radius',
  '--appearance-control-radius',
  '--appearance-panel-radius',
  '--appearance-overlay-radius',
  '--appearance-pill-radius',
  '--appearance-border-width',
  '--appearance-control-border-width',
  '--appearance-state-border-width',
  '--appearance-control-hover-offset',
  '--appearance-control-active-offset',
  '--appearance-motion-distance'
] as const

export const PLUGIN_APP_THEME_GRADIENT_TOKENS = [
  '--appearance-canvas-background-image',
  '--appearance-worktree-sidebar-background-image',
  '--appearance-right-sidebar-background-image'
] as const

export const PLUGIN_APP_THEME_TEXTURE_TOKENS = PLUGIN_APP_THEME_GRADIENT_TOKENS

export const PLUGIN_APP_THEME_DURATION_TOKENS = [
  '--motion-instant',
  '--motion-fast',
  '--motion-base',
  '--motion-enter',
  '--motion-exit',
  '--motion-spinner-cycle'
] as const

export const PLUGIN_APP_THEME_EASING_TOKENS = [
  '--motion-ease-out',
  '--motion-ease-in',
  '--motion-ease-move'
] as const

export const PLUGIN_APP_THEME_NUMBER_TOKENS = [
  '--appearance-disabled-opacity',
  '--appearance-motion-scale'
] as const

export const PLUGIN_APP_THEME_SHADOW_TOKENS = [
  '--appearance-shadow-control',
  '--appearance-shadow-control-hover',
  '--appearance-shadow-control-active',
  '--appearance-shadow-subtle',
  '--appearance-shadow-floating'
] as const

export const PLUGIN_APP_THEME_TOKENS = [
  ...PLUGIN_APP_THEME_COLOR_TOKENS,
  ...PLUGIN_APP_THEME_LENGTH_TOKENS,
  ...PLUGIN_APP_THEME_DURATION_TOKENS,
  ...PLUGIN_APP_THEME_EASING_TOKENS,
  ...PLUGIN_APP_THEME_NUMBER_TOKENS,
  ...PLUGIN_APP_THEME_SHADOW_TOKENS,
  ...PLUGIN_APP_THEME_GRADIENT_TOKENS
] as const

export type PluginAppThemeToken = (typeof PLUGIN_APP_THEME_TOKENS)[number]

const COLOR_TOKENS = new Set<string>(PLUGIN_APP_THEME_COLOR_TOKENS)
const LENGTH_TOKENS = new Set<string>(PLUGIN_APP_THEME_LENGTH_TOKENS)
const SIGNED_LENGTH_TOKENS = new Set<string>([
  '--appearance-control-hover-offset',
  '--appearance-control-active-offset'
])
const DURATION_TOKENS = new Set<string>(PLUGIN_APP_THEME_DURATION_TOKENS)
const EASING_TOKENS = new Set<string>(PLUGIN_APP_THEME_EASING_TOKENS)
const NUMBER_TOKENS = new Set<string>(PLUGIN_APP_THEME_NUMBER_TOKENS)
const SHADOW_TOKENS = new Set<string>(PLUGIN_APP_THEME_SHADOW_TOKENS)
const GRADIENT_TOKENS = new Set<string>(PLUGIN_APP_THEME_GRADIENT_TOKENS)
const THEME_TOKENS = new Set<string>(PLUGIN_APP_THEME_TOKENS)

function hasUnsafeCss(value: string): boolean {
  const normalized = value.toLowerCase()
  return (
    value.length > 192 ||
    normalized.includes('url') ||
    normalized.includes('var(') ||
    /[;{}@'"\\]/.test(value) ||
    !/^[A-Za-z0-9#.,%+\- /()]+$/.test(value)
  )
}

function isSafeTokenValue(token: string, value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || hasUnsafeCss(trimmed)) {
    return GRADIENT_TOKENS.has(token) && isSafeThemeGradient(trimmed)
  }
  if (COLOR_TOKENS.has(token)) {
    return true
  }
  if (SIGNED_LENGTH_TOKENS.has(token)) {
    return /^(?:0|-?\d+(?:\.\d+)?(?:px|rem|em|%))$/.test(trimmed)
  }
  if (LENGTH_TOKENS.has(token)) {
    return /^(?:0|\d+(?:\.\d+)?(?:px|rem|em|%))$/.test(trimmed)
  }
  if (DURATION_TOKENS.has(token)) {
    return /^\d+(?:\.\d+)?(?:ms|s)$/.test(trimmed)
  }
  if (EASING_TOKENS.has(token)) {
    return /^(?:linear|ease|ease-in|ease-out|ease-in-out|cubic-bezier\([\d., +-]+\))$/.test(trimmed)
  }
  if (NUMBER_TOKENS.has(token)) {
    const number = Number(trimmed)
    return Number.isFinite(number) && number >= 0 && number <= 1
  }
  if (GRADIENT_TOKENS.has(token)) {
    return isSafeThemeGradient(trimmed)
  }
  return SHADOW_TOKENS.has(token)
}

const themeTokenValueSchema = z.string().min(1).max(512)
const themeTexturePathSchema = z.string().trim().min(1).max(240)

export const pluginAppThemeArtifactSchema = z
  .object({
    schemaVersion: z
      .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])
      .default(1),
    base: z.enum(['light', 'dark']),
    tokens: z.record(z.string(), themeTokenValueSchema),
    textureAssets: z.record(z.string(), themeTexturePathSchema).optional(),
    terminalThemeContributionId: pluginIdSchema.optional()
  })
  .strict()
  .superRefine((theme, context) => {
    const entries = Object.entries(theme.tokens)
    if (entries.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['tokens'],
        message: 'must define at least one token'
      })
    }
    if (entries.length > PLUGIN_APP_THEME_TOKENS.length) {
      context.addIssue({ code: 'custom', path: ['tokens'], message: 'contains too many tokens' })
    }
    for (const [token, value] of entries) {
      if (!THEME_TOKENS.has(token)) {
        context.addIssue({
          code: 'custom',
          path: ['tokens', token],
          message: 'is not part of the public appearance token set'
        })
      } else if (theme.schemaVersion === 1 && !COLOR_TOKENS.has(token)) {
        context.addIssue({
          code: 'custom',
          path: ['tokens', token],
          message: 'requires appearance theme schemaVersion 2'
        })
      } else if (theme.schemaVersion < 3 && GRADIENT_TOKENS.has(token)) {
        context.addIssue({
          code: 'custom',
          path: ['tokens', token],
          message: 'requires appearance theme schemaVersion 3'
        })
      } else if (!isSafeTokenValue(token, value)) {
        context.addIssue({
          code: 'custom',
          path: ['tokens', token],
          message: 'has an invalid or unsafe appearance value'
        })
      }
    }
    const textureEntries = Object.entries(theme.textureAssets ?? {})
    if (textureEntries.length > PLUGIN_APP_THEME_TEXTURE_TOKENS.length) {
      context.addIssue({
        code: 'custom',
        path: ['textureAssets'],
        message: 'contains too many texture assets'
      })
    }
    for (const [token, path] of textureEntries) {
      if (theme.schemaVersion < 4) {
        context.addIssue({
          code: 'custom',
          path: ['textureAssets', token],
          message: 'requires appearance theme schemaVersion 4'
        })
      } else if (!GRADIENT_TOKENS.has(token)) {
        context.addIssue({
          code: 'custom',
          path: ['textureAssets', token],
          message: 'is not a public appearance texture target'
        })
      } else if (!/\.png$/i.test(path)) {
        context.addIssue({
          code: 'custom',
          path: ['textureAssets', token],
          message: 'must reference a PNG file'
        })
      }
    }
    if (theme.terminalThemeContributionId && theme.schemaVersion < 5) {
      context.addIssue({
        code: 'custom',
        path: ['terminalThemeContributionId'],
        message: 'requires appearance theme schemaVersion 5'
      })
    }
  })

export type PluginAppThemeArtifact = z.infer<typeof pluginAppThemeArtifactSchema>

export type PluginAppThemeTextureToken = (typeof PLUGIN_APP_THEME_TEXTURE_TOKENS)[number]
export type PluginThemeTextureDataUrls = Partial<Record<PluginAppThemeTextureToken, string>>

export type PluginThemeRegistration = Omit<
  PluginAppThemeArtifact,
  'textureAssets' | 'terminalThemeContributionId'
> & {
  id: `plugin:${string}`
  pluginKey: string
  contributionId: string
  label: string
  terminalThemeId?: `plugin:${string}`
  textureDataUrls?: PluginThemeTextureDataUrls
}

export type PluginThemeArtifactParseResult =
  | { ok: true; theme: PluginAppThemeArtifact }
  | { ok: false; error: string }

export function parsePluginAppThemeArtifact(raw: string): PluginThemeArtifactParseResult {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'theme artifact must contain one JSON object' }
  }
  const parsed = pluginAppThemeArtifactSchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return {
      ok: false,
      error: `${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'invalid theme artifact'}`
    }
  }
  return { ok: true, theme: parsed.data }
}
