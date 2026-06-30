import { SCRYER_TAILWIND_PALETTES, type ScryerPaletteId } from './theme-palettes'

export { SCRYER_TAILWIND_PALETTES, type ScryerPaletteId } from './theme-palettes'

export type ScryerThemeMode = 'light' | 'dark' | 'system'

export type ScryerThemeRole =
  | 'background'
  | 'foreground'
  | 'surface'
  | 'muted'
  | 'border'
  | 'primary'
  | 'secondary'
  | 'accent'
  | 'canvas'
  | 'nodeFill'
  | 'nodeBorder'

export type ScryerThemeSettings = {
  mode: ScryerThemeMode
  paletteByRole: Record<ScryerThemeRole, ScryerPaletteId>
  lightOffset: number
  darkOffset: number
  canvasBackground?: string
  nodeFill?: string
}

export type ScryerThemeStyle = Record<`--architecture-${string}`, string>

export const SCRYER_THEME_COLOR_ROLES: { id: ScryerThemeRole; label: string }[] = [
  { id: 'background', label: 'Background' },
  { id: 'foreground', label: 'Foreground' },
  { id: 'surface', label: 'Surface' },
  { id: 'muted', label: 'Muted' },
  { id: 'border', label: 'Border' },
  { id: 'primary', label: 'Primary' },
  { id: 'secondary', label: 'Secondary' },
  { id: 'accent', label: 'Accent' },
  { id: 'canvas', label: 'Canvas' },
  { id: 'nodeFill', label: 'Node fill' },
  { id: 'nodeBorder', label: 'Node border' }
]

const PALETTE_BY_ID = new Map(SCRYER_TAILWIND_PALETTES.map((palette) => [palette.id, palette]))
const PALETTE_IDS = new Set(SCRYER_TAILWIND_PALETTES.map((palette) => palette.id))
const SHADE_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900] as const

export const DEFAULT_SCRYER_THEME: ScryerThemeSettings = {
  mode: 'system',
  paletteByRole: {
    background: 'slate',
    foreground: 'slate',
    surface: 'zinc',
    muted: 'gray',
    border: 'slate',
    primary: 'emerald',
    secondary: 'sky',
    accent: 'violet',
    canvas: 'slate',
    nodeFill: 'emerald',
    nodeBorder: 'slate'
  },
  lightOffset: 0,
  darkOffset: 0,
  canvasBackground: undefined,
  nodeFill: undefined
}

function paletteId(value: unknown, fallback: ScryerPaletteId): ScryerPaletteId {
  return typeof value === 'string' && PALETTE_IDS.has(value as ScryerPaletteId)
    ? (value as ScryerPaletteId)
    : fallback
}

function clampOffset(value: unknown): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0
  return Math.max(-4, Math.min(4, number))
}

function shadeForRole(
  role: ScryerThemeRole,
  dark: boolean,
  offset: number
): (typeof SHADE_STEPS)[number] {
  const base: Record<ScryerThemeRole, number> = {
    background: dark ? 900 : 50,
    foreground: dark ? 100 : 900,
    surface: dark ? 800 : 100,
    muted: dark ? 500 : 500,
    border: dark ? 700 : 200,
    primary: dark ? 400 : 600,
    secondary: dark ? 400 : 600,
    accent: dark ? 400 : 600,
    canvas: dark ? 900 : 50,
    nodeFill: dark ? 800 : 50,
    nodeBorder: dark ? 600 : 300
  }
  const index = SHADE_STEPS.indexOf(base[role] as (typeof SHADE_STEPS)[number])
  const nextIndex = Math.max(0, Math.min(SHADE_STEPS.length - 1, index + offset))
  return SHADE_STEPS[nextIndex]
}

function colorForRole(settings: ScryerThemeSettings, role: ScryerThemeRole, dark: boolean): string {
  const palette = PALETTE_BY_ID.get(settings.paletteByRole[role]) ?? PALETTE_BY_ID.get('slate')!
  const shade = shadeForRole(role, dark, dark ? settings.darkOffset : settings.lightOffset)
  return palette.colors[shade]
}

export function normalizeScryerTheme(value: unknown): ScryerThemeSettings {
  const input =
    typeof value === 'object' && value !== null ? (value as Partial<ScryerThemeSettings>) : {}
  const mode =
    input.mode === 'light' || input.mode === 'dark' || input.mode === 'system'
      ? input.mode
      : DEFAULT_SCRYER_THEME.mode
  const paletteByRole = { ...DEFAULT_SCRYER_THEME.paletteByRole }
  for (const role of SCRYER_THEME_COLOR_ROLES) {
    paletteByRole[role.id] = paletteId(input.paletteByRole?.[role.id], paletteByRole[role.id])
  }
  return {
    mode,
    paletteByRole,
    lightOffset: clampOffset(input.lightOffset),
    darkOffset: clampOffset(input.darkOffset),
    canvasBackground:
      typeof input.canvasBackground === 'string' && input.canvasBackground.trim()
        ? input.canvasBackground.trim()
        : undefined,
    nodeFill:
      typeof input.nodeFill === 'string' && input.nodeFill.trim()
        ? input.nodeFill.trim()
        : undefined
  }
}

export function createScryerThemeStyle(
  settings: ScryerThemeSettings,
  resolvedDark: boolean
): ScryerThemeStyle {
  const style: ScryerThemeStyle = {
    '--architecture-canvas-bg':
      settings.canvasBackground ?? colorForRole(settings, 'canvas', resolvedDark),
    '--architecture-node-fill':
      settings.nodeFill ?? colorForRole(settings, 'nodeFill', resolvedDark),
    '--architecture-node-border': colorForRole(settings, 'nodeBorder', resolvedDark)
  }
  for (const role of SCRYER_THEME_COLOR_ROLES) {
    style[`--architecture-role-${role.id}`] = colorForRole(settings, role.id, resolvedDark)
  }
  return style
}
