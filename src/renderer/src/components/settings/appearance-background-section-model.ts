import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  DEFAULT_ORCA_BACKGROUND_SETTINGS,
  type OrcaBackgroundArea,
  type OrcaBackgroundFit,
  type OrcaBackgroundSettings
} from '../../../../shared/orca-background-settings'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export type AppearanceBackgroundArea = OrcaBackgroundArea

export function getAppearanceBackgroundAreaOptions(): readonly {
  value: AppearanceBackgroundArea
  label: string
  description: string
}[] {
  return [
    {
      value: 'terminal',
      label: translate('auto.components.settings.AppearanceBackgroundSection.terminal', 'Terminal'),
      description: translate(
        'auto.components.settings.AppearanceBackgroundSection.terminalDescription',
        'Show the background behind terminal panes.'
      )
    },
    {
      value: 'leftSidebar',
      label: translate(
        'auto.components.settings.AppearanceBackgroundSection.leftSidebar',
        'Left Sidebar'
      ),
      description: translate(
        'auto.components.settings.AppearanceBackgroundSection.leftSidebarDescription',
        'Show the background behind the workspace sidebar.'
      )
    },
    {
      value: 'rightSidebar',
      label: translate(
        'auto.components.settings.AppearanceBackgroundSection.rightSidebar',
        'Right Sidebar'
      ),
      description: translate(
        'auto.components.settings.AppearanceBackgroundSection.rightSidebarDescription',
        'Show the background behind explorer and source control panels.'
      )
    }
  ]
}

export function getAppearanceBackgroundFitOptions(): readonly {
  value: OrcaBackgroundFit
  label: string
}[] {
  return [
    {
      value: 'cover',
      label: translate('auto.components.settings.AppearanceBackgroundSection.cover', 'Cover')
    },
    {
      value: 'contain',
      label: translate('auto.components.settings.AppearanceBackgroundSection.contain', 'Contain')
    },
    {
      value: 'stretch',
      label: translate('auto.components.settings.AppearanceBackgroundSection.stretch', 'Stretch')
    },
    {
      value: 'tile',
      label: translate('auto.components.settings.AppearanceBackgroundSection.tile', 'Tile')
    }
  ]
}

export function resolveAppearanceBackgroundAreas(
  settings: Partial<OrcaBackgroundSettings>
): Record<AppearanceBackgroundArea, boolean> {
  const areas = settings.orcaBackgroundAreas
  return {
    terminal: areas?.terminal ?? DEFAULT_ORCA_BACKGROUND_SETTINGS.orcaBackgroundAreas.terminal,
    leftSidebar:
      areas?.leftSidebar ?? DEFAULT_ORCA_BACKGROUND_SETTINGS.orcaBackgroundAreas.leftSidebar,
    rightSidebar:
      areas?.rightSidebar ?? DEFAULT_ORCA_BACKGROUND_SETTINGS.orcaBackgroundAreas.rightSidebar
  }
}

export function resolveAppearanceBackgroundImage(
  settings: Partial<OrcaBackgroundSettings>,
  area: AppearanceBackgroundArea
): string | null {
  if (settings.orcaBackgroundByArea && Object.hasOwn(settings.orcaBackgroundByArea, area)) {
    return settings.orcaBackgroundByArea[area] || null
  }
  return settings.orcaBackgroundImage || null
}

export function resolveAppearanceBackgroundNumber(
  areaValues: Partial<Record<AppearanceBackgroundArea, number>> | undefined,
  shared: number | undefined,
  area: AppearanceBackgroundArea,
  fallback: number,
  max: number
): number {
  const value = areaValues?.[area]
  const resolved = typeof value === 'number' && Number.isFinite(value) ? value : shared
  return typeof resolved === 'number' && Number.isFinite(resolved)
    ? Math.min(max, Math.max(0, resolved))
    : fallback
}

export function asBackgroundSettingsUpdate(
  updates: Partial<OrcaBackgroundSettings>
): Partial<GlobalSettings> {
  return updates
}

export function getAppearanceBackgroundSearchEntry(): {
  title: string
  description: string
  keywords: string[]
} {
  return {
    title: translate(
      'auto.components.settings.AppearanceBackgroundSection.title',
      'Background Image'
    ),
    description: translate(
      'auto.components.settings.AppearanceBackgroundSection.description',
      'Use your own images behind the terminal and sidebars.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.AppearanceBackgroundSection.keywordBackground',
        'background'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.AppearanceBackgroundSection.keywordImage',
        'image'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.AppearanceBackgroundSection.keywordWallpaper',
        'wallpaper'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.AppearanceBackgroundSection.keywordTerminal',
        'terminal'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.AppearanceBackgroundSection.keywordSidebar',
        'sidebar'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.AppearanceBackgroundSection.keywordOpacity',
        'opacity'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.AppearanceBackgroundSection.keywordBlur',
        'blur'
      )
    ]
  }
}
