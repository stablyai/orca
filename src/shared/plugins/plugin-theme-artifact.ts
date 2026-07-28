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

export type PluginAppThemeToken = (typeof PLUGIN_APP_THEME_TOKENS)[number]

const THEME_TOKEN_SET = new Set<string>(PLUGIN_APP_THEME_TOKENS)

function isSafeThemeTokenValue(value: string): boolean {
  const normalized = value.toLowerCase()
  return (
    value.length <= 128 &&
    !normalized.includes('url') &&
    !normalized.includes('var(') &&
    !/[;{}@'"\\]/.test(value) &&
    /^[A-Za-z0-9#.,%+\- /()]+$/.test(value)
  )
}

const themeTokenValueSchema = z
  .string()
  .min(1)
  .refine(isSafeThemeTokenValue, 'must be a bounded color value without URLs or CSS declarations')

export const pluginAppThemeArtifactSchema = z
  .object({
    base: z.enum(['light', 'dark']),
    tokens: z.record(z.string(), themeTokenValueSchema)
  })
  .strict()
  .superRefine((theme, ctx) => {
    const entries = Object.entries(theme.tokens)
    if (entries.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['tokens'], message: 'must define at least one token' })
    }
    for (const [token] of entries) {
      if (!THEME_TOKEN_SET.has(token)) {
        ctx.addIssue({
          code: 'custom',
          path: ['tokens', token],
          message: 'is not part of the public plugin theme token set'
        })
      }
    }
  })

export type PluginAppThemeArtifact = z.infer<typeof pluginAppThemeArtifactSchema>

export type PluginThemeRegistration = PluginAppThemeArtifact & {
  /** Stable host-owned id; plugin ids cannot collide across publishers. */
  id: `plugin:${string}`
  pluginKey: string
  contributionId: string
  label: string
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
