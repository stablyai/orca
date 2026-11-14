import { z } from 'zod'
import {
  isThemeColorValue,
  PLUGIN_APP_THEME_REQUIRED_TOKENS,
  PLUGIN_APP_THEME_TOKENS,
  tokenColorsSchema,
  type PluginThemeTokenColorRule
} from '../plugins/artifacts/plugin-theme-artifact'
import {
  normalizeTerminalColorOverrides,
  normalizeTerminalHexColor,
  TERMINAL_COLOR_KEYS
} from '../terminal-themes/terminal-custom-themes'
import type { TerminalColorOverrides } from '../terminal-themes/terminal-color-overrides'
import { adjustThemeColor, type ThemeColorAdjustment } from '../color/oklch-color-transform'
import { THEME_STUDIO_ERROR_CODES, ThemeStudioError } from './theme-studio-errors'

export const THEME_STUDIO_MODES = ['light', 'dark'] as const
export type ThemeStudioMode = (typeof THEME_STUDIO_MODES)[number]

/** Terminal palette entries are addressed as `terminal.<key>`, beside the app's `--tokens`. */
export const THEME_STUDIO_TERMINAL_PREFIX = 'terminal.'

const APP_TOKENS: ReadonlySet<string> = new Set(PLUGIN_APP_THEME_TOKENS)
const TERMINAL_KEYS: ReadonlySet<string> = new Set(TERMINAL_COLOR_KEYS)
const MAX_NAME_LENGTH = 64
const REQUIRED_TOKENS: ReadonlySet<string> = new Set(PLUGIN_APP_THEME_REQUIRED_TOKENS)

const tokenRecordSchema = z.record(
  z.string().refine((token) => APP_TOKENS.has(token), 'is not a public theme token'),
  z.string().refine(isThemeColorValue, 'must be a color value')
)

export const themeStudioVariantSchema = z.object({
  tokens: tokenRecordSchema,
  tokenColors: tokenColorsSchema.optional(),
  terminal: z
    .partialRecord(
      z.enum(TERMINAL_COLOR_KEYS),
      z.string().refine((value) => normalizeTerminalHexColor(value) !== null, 'must be a hex color')
    )
    .optional()
})

export type ThemeStudioVariant = {
  tokens: Record<string, string>
  tokenColors?: PluginThemeTokenColorRule[]
  terminal?: TerminalColorOverrides
}

export const themeStudioDraftSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
  light: themeStudioVariantSchema.nullable(),
  dark: themeStudioVariantSchema.nullable()
})

export type ThemeStudioDraft = {
  name: string
  light: ThemeStudioVariant | null
  dark: ThemeStudioVariant | null
}

const variantPatchSchema = z.strictObject({
  set: z.record(z.string(), z.string().max(256)).optional(),
  unset: z.array(z.string()).max(256).optional(),
  tokenColors: tokenColorsSchema.nullable().optional()
})
export const themeStudioPatchSchema = z.strictObject({
  light: variantPatchSchema.optional(),
  dark: variantPatchSchema.optional()
})
export type ThemeStudioPatch = z.infer<typeof themeStudioPatchSchema>

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
    }
    previous = current
  }
  return previous[b.length]
}

const MAX_SUGGESTIONS = 5

/** Closest public names to a mistyped one, so a typo is fixed in one step. */
export function nearestThemeStudioKeys(key: string): string[] {
  const typed = key.trim().toLowerCase()
  const bare = (name: string): string => name.toLowerCase().replace(/^--/, '')
  const terminal = typed.startsWith(THEME_STUDIO_TERMINAL_PREFIX)
  const candidates = terminal
    ? TERMINAL_COLOR_KEYS.map((name) => `${THEME_STUDIO_TERMINAL_PREFIX}${name}`)
    : [...PLUGIN_APP_THEME_TOKENS]
  return candidates
    .map((candidate) => ({ candidate, distance: editDistance(bare(typed), bare(candidate)) }))
    .filter(({ distance }) => distance <= Math.max(3, Math.floor(bare(typed).length / 3)))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, MAX_SUGGESTIONS)
    .map(({ candidate }) => candidate)
}

function invalidKey(key: string): ThemeStudioError {
  const nearest = nearestThemeStudioKeys(key)
  return new ThemeStudioError(THEME_STUDIO_ERROR_CODES.invalid, `${key} is not a theme token`, {
    key,
    nearest,
    nextSteps: [
      ...(nearest.length ? [`Did you mean ${nearest.join(', ')}?`] : []),
      'Run `orca theme tokens --json` for every token and terminal color.'
    ]
  })
}

function invalidValue(key: string, value: string, hint: string): ThemeStudioError {
  return new ThemeStudioError(THEME_STUDIO_ERROR_CODES.invalid, `${key}: ${value} ${hint}`, {
    key,
    value,
    nextSteps: ['Use a hex color such as #1e1b2e, or rgb(), hsl() or oklch().']
  })
}

type ThemeStudioKey =
  | { kind: 'token'; token: string }
  | { kind: 'terminal'; key: keyof TerminalColorOverrides }

function isTerminalKey(key: string): key is keyof TerminalColorOverrides {
  return TERMINAL_KEYS.has(key)
}

/** `--background` and `background` name the app token; `terminal.red` a terminal color. */
export function parseThemeStudioKey(raw: string): ThemeStudioKey {
  const key = raw.trim()
  if (key.startsWith(THEME_STUDIO_TERMINAL_PREFIX)) {
    const name = key.slice(THEME_STUDIO_TERMINAL_PREFIX.length)
    if (isTerminalKey(name)) {
      return { kind: 'terminal', key: name }
    }
    throw invalidKey(key)
  }
  const token = key.startsWith('--') ? key : `--${key}`
  if (!APP_TOKENS.has(token)) {
    throw invalidKey(key)
  }
  return { kind: 'token', token }
}

function setVariantValue(variant: ThemeStudioVariant, rawKey: string, value: string): string {
  const key = parseThemeStudioKey(rawKey)
  const trimmed = value.trim()
  if (key.kind === 'token') {
    if (!isThemeColorValue(trimmed)) {
      throw invalidValue(key.token, trimmed, 'is not a color value')
    }
    variant.tokens[key.token] = trimmed
    return key.token
  }
  const normalized = normalizeTerminalColorOverrides({ [key.key]: trimmed })[key.key]
  if (!normalized) {
    throw invalidValue(`${THEME_STUDIO_TERMINAL_PREFIX}${key.key}`, trimmed, 'must be a hex color')
  }
  variant.terminal = { ...variant.terminal, [key.key]: normalized }
  return `${THEME_STUDIO_TERMINAL_PREFIX}${key.key}`
}

function unsetVariantValue(variant: ThemeStudioVariant, rawKey: string): string {
  const key = parseThemeStudioKey(rawKey)
  if (key.kind === 'token') {
    if (REQUIRED_TOKENS.has(key.token)) {
      throw new ThemeStudioError(THEME_STUDIO_ERROR_CODES.invalid, `${key.token} is required`, {
        key: key.token,
        nextSteps: ['Set it to another color instead of removing it.']
      })
    }
    delete variant.tokens[key.token]
    return key.token
  }
  if (variant.terminal) {
    const { [key.key]: _removed, ...rest } = variant.terminal
    variant.terminal = rest
  }
  return `${THEME_STUDIO_TERMINAL_PREFIX}${key.key}`
}

export function cloneThemeStudioVariant(variant: ThemeStudioVariant): ThemeStudioVariant {
  return {
    tokens: { ...variant.tokens },
    ...(variant.tokenColors
      ? { tokenColors: variant.tokenColors.map((rule) => structuredClone(rule)) }
      : {}),
    ...(variant.terminal ? { terminal: { ...variant.terminal } } : {})
  }
}

function missingVariant(mode: ThemeStudioMode): ThemeStudioError {
  return new ThemeStudioError(
    THEME_STUDIO_ERROR_CODES.invalid,
    `This draft has no ${mode} variant.`,
    {
      mode,
      nextSteps: [
        `Pass --mode for the variant it has, or start a draft with both: \`orca theme edit --from current\`.`
      ]
    }
  )
}

/** Applies a patch to a copy of the draft; throws on the first unknown key or bad value. */
export function applyThemeStudioPatch(
  draft: ThemeStudioDraft,
  patch: ThemeStudioPatch
): { draft: ThemeStudioDraft; changed: Record<ThemeStudioMode, string[]> } {
  const next: ThemeStudioDraft = { ...draft }
  const changed: Record<ThemeStudioMode, string[]> = { light: [], dark: [] }
  for (const mode of THEME_STUDIO_MODES) {
    const edit = patch[mode]
    if (!edit) {
      continue
    }
    const current = draft[mode]
    if (!current) {
      throw missingVariant(mode)
    }
    const variant = cloneThemeStudioVariant(current)
    for (const [key, value] of Object.entries(edit.set ?? {})) {
      changed[mode].push(setVariantValue(variant, key, value))
    }
    for (const key of edit.unset ?? []) {
      changed[mode].push(unsetVariantValue(variant, key))
    }
    if (edit.tokenColors !== undefined) {
      if (edit.tokenColors === null) {
        delete variant.tokenColors
      } else {
        variant.tokenColors = edit.tokenColors
      }
      changed[mode].push('tokenColors')
    }
    next[mode] = variant
  }
  return { draft: next, changed }
}

/** Which keys an adjustment touches: every key unless `only` names prefixes such as `--sidebar`. */
function matchesOnly(key: string, only: readonly string[] | undefined): boolean {
  return !only?.length || only.some((prefix) => key.startsWith(prefix))
}

/** Adjusts every color of a variant the transform can read; the rest are reported as skipped. */
export function adjustThemeStudioVariant(
  variant: ThemeStudioVariant,
  adjustment: ThemeColorAdjustment,
  only?: readonly string[]
): { variant: ThemeStudioVariant; changed: string[]; skipped: string[] } {
  const next = cloneThemeStudioVariant(variant)
  const changed: string[] = []
  const skipped: string[] = []
  // Why the original canvases: contrast moves each color away from what it is read against.
  const appCanvas = variant.tokens['--background']
  const terminalCanvas = variant.terminal?.background ?? appCanvas
  const adjust = (key: string, value: string, canvas: string | undefined): string => {
    if (!matchesOnly(key, only)) {
      return value
    }
    const adjusted = adjustThemeColor(value, adjustment, canvas)
    if (adjusted === null) {
      skipped.push(key)
      return value
    }
    if (adjusted !== value.toLowerCase()) {
      changed.push(key)
    }
    return adjusted
  }
  for (const [token, value] of Object.entries(next.tokens)) {
    next.tokens[token] = adjust(token, value, appCanvas)
  }
  if (next.terminal) {
    for (const key of TERMINAL_COLOR_KEYS) {
      const value = next.terminal[key]
      if (value) {
        next.terminal[key] = adjust(`${THEME_STUDIO_TERMINAL_PREFIX}${key}`, value, terminalCanvas)
      }
    }
  }
  next.tokenColors?.forEach((rule, index) => {
    if (rule.settings.foreground) {
      rule.settings.foreground = adjust(
        `tokenColors.${index}`,
        rule.settings.foreground,
        variant.tokens['--editor-surface'] ?? appCanvas
      )
    }
  })
  return { variant: next, changed, skipped }
}
