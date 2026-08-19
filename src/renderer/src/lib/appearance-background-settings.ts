import {
  DEFAULT_ORCA_BACKGROUND_SETTINGS,
  ORCA_BACKGROUND_AREAS,
  type OrcaBackgroundArea,
  type OrcaBackgroundFit,
  type OrcaBackgroundSettings
} from '../../../shared/orca-background-settings'

export type AppearanceBackgroundArea = OrcaBackgroundArea

export type ResolvedAppearanceBackground = {
  area: AppearanceBackgroundArea
  imageName: string | null
  active: boolean
  opacity: number
  blurPx: number
  fit: OrcaBackgroundFit
}

const DOM_AREA_NAMES = {
  terminal: 'terminal',
  leftSidebar: 'left-sidebar',
  rightSidebar: 'right-sidebar'
} as const satisfies Record<AppearanceBackgroundArea, string>

const BACKGROUND_FITS = new Set<OrcaBackgroundFit>(['cover', 'contain', 'stretch', 'tile'])

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback
}

function resolveAreaNumber(
  byArea: unknown,
  area: AppearanceBackgroundArea,
  shared: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  if (byArea && typeof byArea === 'object' && Object.hasOwn(byArea, area)) {
    const areaValue = (byArea as Record<AppearanceBackgroundArea, unknown>)[area]
    if (typeof areaValue === 'number' && Number.isFinite(areaValue)) {
      return clampNumber(areaValue, fallback, min, max)
    }
  }
  return clampNumber(shared, fallback, min, max)
}

function resolveImageName(
  settings: Partial<OrcaBackgroundSettings>,
  area: AppearanceBackgroundArea
): string | null {
  const byArea = settings.orcaBackgroundByArea
  if (byArea && Object.hasOwn(byArea, area)) {
    const areaImage = byArea[area]
    return typeof areaImage === 'string' && areaImage.length > 0 ? areaImage : null
  }
  return typeof settings.orcaBackgroundImage === 'string' && settings.orcaBackgroundImage.length > 0
    ? settings.orcaBackgroundImage
    : null
}

function resolveAreaEnabled(
  settings: Partial<OrcaBackgroundSettings>,
  area: AppearanceBackgroundArea
): boolean {
  const configured = settings.orcaBackgroundAreas?.[area]
  return typeof configured === 'boolean'
    ? configured
    : DEFAULT_ORCA_BACKGROUND_SETTINGS.orcaBackgroundAreas[area]
}

function resolveFit(value: unknown): OrcaBackgroundFit {
  return typeof value === 'string' && BACKGROUND_FITS.has(value as OrcaBackgroundFit)
    ? (value as OrcaBackgroundFit)
    : DEFAULT_ORCA_BACKGROUND_SETTINGS.orcaBackgroundFit
}

export function getAppearanceBackgroundDomArea(area: AppearanceBackgroundArea): string {
  return DOM_AREA_NAMES[area]
}

export function resolveAppearanceBackground(
  settings: Partial<OrcaBackgroundSettings> | null | undefined,
  area: AppearanceBackgroundArea
): ResolvedAppearanceBackground {
  const background = settings ?? {}
  const imageName = resolveImageName(background, area)

  return {
    area,
    imageName,
    active: imageName !== null && resolveAreaEnabled(background, area),
    opacity: resolveAreaNumber(
      background.orcaBackgroundOpacityByArea,
      area,
      background.orcaBackgroundOpacity,
      DEFAULT_ORCA_BACKGROUND_SETTINGS.orcaBackgroundOpacity,
      0,
      1
    ),
    blurPx: resolveAreaNumber(
      background.orcaBackgroundBlurByArea,
      area,
      background.orcaBackgroundBlur,
      DEFAULT_ORCA_BACKGROUND_SETTINGS.orcaBackgroundBlur,
      0,
      40
    ),
    fit: resolveFit(background.orcaBackgroundFit)
  }
}

export { ORCA_BACKGROUND_AREAS }
