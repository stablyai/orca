export const ORCA_BACKGROUND_AREAS = ['terminal', 'leftSidebar', 'rightSidebar'] as const

export type OrcaBackgroundArea = (typeof ORCA_BACKGROUND_AREAS)[number]
export type OrcaBackgroundFit = 'cover' | 'contain' | 'stretch' | 'tile'
export type OrcaBackgroundAreaMap<T> = Partial<Record<OrcaBackgroundArea, T>>

export type OrcaBackgroundSettings = {
  /** Legacy shared image retained so profiles from the first background build still migrate. */
  orcaBackgroundImage?: string | null
  orcaBackgroundByArea: OrcaBackgroundAreaMap<string | null>
  /** Legacy shared opacity retained as the fallback for areas without an override. */
  orcaBackgroundOpacity: number
  orcaBackgroundOpacityByArea: OrcaBackgroundAreaMap<number>
  /** Legacy shared blur retained as the fallback for areas without an override. */
  orcaBackgroundBlur: number
  orcaBackgroundBlurByArea: OrcaBackgroundAreaMap<number>
  orcaBackgroundFit: OrcaBackgroundFit
  orcaBackgroundAreas: Record<OrcaBackgroundArea, boolean>
}

export const DEFAULT_ORCA_BACKGROUND_SETTINGS: Readonly<OrcaBackgroundSettings> = {
  orcaBackgroundImage: null,
  orcaBackgroundByArea: {},
  orcaBackgroundOpacity: 0.35,
  orcaBackgroundOpacityByArea: {},
  orcaBackgroundBlur: 0,
  orcaBackgroundBlurByArea: {},
  orcaBackgroundFit: 'cover',
  orcaBackgroundAreas: {
    terminal: true,
    leftSidebar: false,
    rightSidebar: false
  }
}

export function getDefaultOrcaBackgroundSettings(): OrcaBackgroundSettings {
  return {
    ...DEFAULT_ORCA_BACKGROUND_SETTINGS,
    orcaBackgroundByArea: {},
    orcaBackgroundOpacityByArea: {},
    orcaBackgroundBlurByArea: {},
    orcaBackgroundAreas: { ...DEFAULT_ORCA_BACKGROUND_SETTINGS.orcaBackgroundAreas }
  }
}

export const ORCA_BACKGROUND_SETTING_KEYS = [
  'orcaBackgroundImage',
  'orcaBackgroundByArea',
  'orcaBackgroundOpacity',
  'orcaBackgroundOpacityByArea',
  'orcaBackgroundBlur',
  'orcaBackgroundBlurByArea',
  'orcaBackgroundFit',
  'orcaBackgroundAreas'
] as const satisfies readonly (keyof OrcaBackgroundSettings)[]

const ORCA_BACKGROUND_FITS: readonly OrcaBackgroundFit[] = ['cover', 'contain', 'stretch', 'tile']

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeFileName(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 255 ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value === '.' ||
    value === '..'
  ) {
    return null
  }
  return value
}

function normalizeNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback
}

function normalizeImageMap(value: unknown): OrcaBackgroundAreaMap<string | null> {
  if (!isRecord(value)) {
    return {}
  }
  const result: OrcaBackgroundAreaMap<string | null> = {}
  for (const area of ORCA_BACKGROUND_AREAS) {
    if (!Object.hasOwn(value, area)) {
      continue
    }
    result[area] = value[area] === null ? null : normalizeFileName(value[area])
  }
  return result
}

function normalizeNumberMap(
  value: unknown,
  min: number,
  max: number
): OrcaBackgroundAreaMap<number> {
  if (!isRecord(value)) {
    return {}
  }
  const result: OrcaBackgroundAreaMap<number> = {}
  for (const area of ORCA_BACKGROUND_AREAS) {
    const candidate = value[area]
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      result[area] = Math.min(max, Math.max(min, candidate))
    }
  }
  return result
}

function normalizeEnabledAreas(value: unknown): Record<OrcaBackgroundArea, boolean> {
  const source = isRecord(value) ? value : {}
  return {
    terminal:
      typeof source.terminal === 'boolean'
        ? source.terminal
        : DEFAULT_ORCA_BACKGROUND_SETTINGS.orcaBackgroundAreas.terminal,
    leftSidebar:
      typeof source.leftSidebar === 'boolean'
        ? source.leftSidebar
        : DEFAULT_ORCA_BACKGROUND_SETTINGS.orcaBackgroundAreas.leftSidebar,
    rightSidebar:
      typeof source.rightSidebar === 'boolean'
        ? source.rightSidebar
        : DEFAULT_ORCA_BACKGROUND_SETTINGS.orcaBackgroundAreas.rightSidebar
  }
}

export function normalizeOrcaBackgroundSettings(value: unknown): OrcaBackgroundSettings {
  const source = isRecord(value) ? value : {}
  const fit = source.orcaBackgroundFit
  return {
    orcaBackgroundImage: normalizeFileName(source.orcaBackgroundImage),
    orcaBackgroundByArea: normalizeImageMap(source.orcaBackgroundByArea),
    orcaBackgroundOpacity: normalizeNumber(
      source.orcaBackgroundOpacity,
      DEFAULT_ORCA_BACKGROUND_SETTINGS.orcaBackgroundOpacity,
      0,
      1
    ),
    orcaBackgroundOpacityByArea: normalizeNumberMap(source.orcaBackgroundOpacityByArea, 0, 1),
    orcaBackgroundBlur: normalizeNumber(
      source.orcaBackgroundBlur,
      DEFAULT_ORCA_BACKGROUND_SETTINGS.orcaBackgroundBlur,
      0,
      40
    ),
    orcaBackgroundBlurByArea: normalizeNumberMap(source.orcaBackgroundBlurByArea, 0, 40),
    orcaBackgroundFit:
      typeof fit === 'string' && ORCA_BACKGROUND_FITS.includes(fit as OrcaBackgroundFit)
        ? (fit as OrcaBackgroundFit)
        : DEFAULT_ORCA_BACKGROUND_SETTINGS.orcaBackgroundFit,
    orcaBackgroundAreas: normalizeEnabledAreas(source.orcaBackgroundAreas)
  }
}

export function normalizeOrcaBackgroundSettingsUpdate(
  updates: object,
  current: Partial<OrcaBackgroundSettings>
): Partial<OrcaBackgroundSettings> {
  const normalized = normalizeOrcaBackgroundSettings({ ...current, ...updates })
  const result: Partial<OrcaBackgroundSettings> = {}
  for (const key of ORCA_BACKGROUND_SETTING_KEYS) {
    if (Object.hasOwn(updates, key)) {
      Object.assign(result, { [key]: normalized[key] })
    }
  }
  return result
}
