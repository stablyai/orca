import { z } from 'zod'

// Why: this is a public, additive-only theme API. Exposing every main.css
// variable would make internal renderer refactors plugin-breaking changes.
export const PLUGIN_APP_THEME_TOKENS = [
  '--background',
  '--editor-surface',
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
  '--border',
  '--input',
  '--ring',
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
  '--worktree-sidebar-ring'
] as const

const THEME_TOKEN_SET = new Set<string>(PLUGIN_APP_THEME_TOKENS)

/** Every theme sets these; the rest are optional and derived from them when omitted. */
export const PLUGIN_APP_THEME_REQUIRED_TOKENS = ['--background', '--foreground'] as const

// Why: an omitted token would otherwise keep the built-in value and clash with the theme's
// palette (e.g. a neutral grey selected row on a purple theme). A rule names source tokens
// (first present wins) or mixes the theme's foreground into its background; the renderer's
// contrast check still drops any derived pair that ends up unreadable.
type DerivationRule = readonly string[] | { mixForeground: number }

const DERIVED_TOKENS: Record<string, DerivationRule> = {
  '--editor-surface': ['--background'],
  '--card': ['--background'],
  '--card-foreground': ['--foreground'],
  '--popover': ['--card', '--background'],
  '--popover-foreground': ['--card-foreground', '--foreground'],
  '--primary': ['--foreground'],
  '--primary-foreground': ['--background'],
  '--muted': ['--secondary'],
  '--secondary': ['--muted'],
  '--muted-foreground': { mixForeground: 70 },
  '--border': { mixForeground: 16 },
  '--accent': { mixForeground: 12 },
  '--accent-foreground': ['--foreground'],
  '--secondary-foreground': ['--foreground'],
  '--input': ['--border'],
  '--ring': ['--primary'],
  '--sidebar': ['--background'],
  '--sidebar-foreground': ['--foreground'],
  '--sidebar-primary': ['--primary'],
  '--sidebar-primary-foreground': ['--primary-foreground'],
  '--sidebar-accent': ['--accent'],
  '--sidebar-accent-foreground': ['--accent-foreground'],
  '--sidebar-border': ['--border'],
  '--sidebar-ring': ['--ring'],
  '--worktree-sidebar': ['--sidebar'],
  '--worktree-sidebar-foreground': ['--sidebar-foreground'],
  '--worktree-sidebar-accent': ['--sidebar-accent'],
  '--worktree-sidebar-accent-foreground': ['--sidebar-accent-foreground'],
  '--worktree-sidebar-border': ['--sidebar-border'],
  '--worktree-sidebar-ring': ['--sidebar-ring'],
  '--chart-1': ['--primary']
}

/** Fills omitted tokens from the ones the theme set, in dependency order. */
export function completePluginAppThemeTokens(
  tokens: Record<string, string>
): Record<string, string> {
  const complete = { ...tokens }
  for (const [token, rule] of Object.entries(DERIVED_TOKENS)) {
    if (complete[token]) {
      continue
    }
    const derived =
      'mixForeground' in rule
        ? `color-mix(in srgb, ${complete['--foreground']} ${rule.mixForeground}%, ${complete['--background']})`
        : rule.map((source) => complete[source]).find(Boolean)
    if (derived) {
      complete[token] = derived
    }
  }
  return complete
}

const NON_COLOR_KEYWORDS = new Set([
  'transparent',
  'currentcolor',
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
  'none'
])

// Why: values land in CSS custom properties, so only color syntax is accepted: hex, a color
// function, or a bare color name. The renderer also requires CSS.supports('color', value).
function isThemeColorValue(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return (
    normalized.length <= 64 &&
    !NON_COLOR_KEYWORDS.has(normalized) &&
    (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(normalized) ||
      /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([0-9.,%/ +-]*(?:deg|turn|rad)?[0-9.,%/ +-]*\)$/.test(
        normalized
      ) ||
      /^[a-z]{3,20}$/.test(normalized))
  )
}

const themeFields = {
  base: z.enum(['light', 'dark']),
  tokens: z.record(
    z.string().refine((token) => THEME_TOKEN_SET.has(token), 'is not a public theme token'),
    z.string().refine(isThemeColorValue, 'must be a color value')
  )
}

const hasRequiredTokens = (theme: { tokens: Record<string, string> }): boolean =>
  PLUGIN_APP_THEME_REQUIRED_TOKENS.every((token) => theme.tokens[token])

const pluginAppThemeArtifactSchema = z
  .object(themeFields)
  .strict()
  .refine(hasRequiredTokens, `must define ${PLUGIN_APP_THEME_REQUIRED_TOKENS.join(' and ')}`)

/** Host-owned id; plugin keys keep ids from colliding across publishers. */
export const pluginContentIdSchema = z.templateLiteral(['plugin:', z.string()])

// Why looser values here: the host adds derived color-mix() values; the renderer still accepts
// only what CSS parses as a color and checks contrast before painting.
const registrationTokenValueSchema = z
  .string()
  .max(256)
  .refine((value) => !/url\(|var\(|[;{}\\]/i.test(value), 'must be a color value')

const pluginThemeRegistrationSchema = z
  .object({
    base: themeFields.base,
    tokens: z.record(
      z.string().refine((token) => THEME_TOKEN_SET.has(token)),
      registrationTokenValueSchema
    ),
    id: pluginContentIdSchema,
    /** Changes whenever the theme's content does, so a cached paint can be checked. */
    revision: z.string().max(128),
    pluginKey: z.string(),
    pluginName: z.string(),
    label: z.string()
  })
  .refine(hasRequiredTokens)

export type PluginAppThemeArtifact = z.infer<typeof pluginAppThemeArtifactSchema>
export type PluginThemeRegistration = z.infer<typeof pluginThemeRegistrationSchema>

/** Parses a theme and fills its omitted tokens. */
export function parsePluginAppThemeArtifact(raw: string): PluginAppThemeArtifact {
  const theme = pluginAppThemeArtifactSchema.parse(JSON.parse(raw))
  return { base: theme.base, tokens: completePluginAppThemeTokens(theme.tokens) }
}

export function isPluginThemeRegistration(value: unknown): value is PluginThemeRegistration {
  return pluginThemeRegistrationSchema.safeParse(value).success
}
