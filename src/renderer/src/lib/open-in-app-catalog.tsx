import type React from 'react'
import { AppWindow } from 'lucide-react'
import type { OpenInApplication } from '../../../shared/ui-chrome-types'
import { cn } from './utils'
import { getOpenInAppIconGlyph } from './open-in-app-icon-set'
import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export type OpenInAppPreset = {
  id: string
  label: string
  command: string
  faviconDomain: string
  iconClassName?: string
}

export const getOpenInAppPresets = createLocalizedCatalog(() => [
  {
    id: 'vscode',
    label: translate('auto.lib.open.in.app.catalog.173553f73a', 'VS Code'),
    command: 'code',
    faviconDomain: 'code.visualstudio.com'
  },
  {
    id: 'cursor',
    label: translate('auto.lib.open.in.app.catalog.d62b12e98a', 'Cursor'),
    command: 'cursor',
    faviconDomain: 'cursor.com'
  },
  {
    id: 'zed',
    label: translate('auto.lib.open.in.app.catalog.f8b8ca2711', 'Zed'),
    command: 'zed',
    faviconDomain: 'zed.dev',
    // Why: Zed's favicon is a black transparent mark, which disappears on dark menus.
    iconClassName: 'dark:invert'
  }
])

export function getOpenInAppPreset(
  application: Pick<OpenInApplication, 'command'>
): OpenInAppPreset | null {
  const command = application.command.trim().toLowerCase()
  return getOpenInAppPresets().find((preset) => preset.command === command) ?? null
}

export function isOpenInAppPresetAdded(
  applications: readonly Pick<OpenInApplication, 'command'>[],
  preset: OpenInAppPreset
): boolean {
  return applications.some(
    (application) => application.command.trim().toLowerCase() === preset.command
  )
}

export function OpenInApplicationIcon({
  application,
  size = 14,
  imageClassName
}: {
  application: Pick<OpenInApplication, 'command' | 'icon'>
  size?: number
  // Why: a real app icon can fill its frame edge to edge, which a glyph should not.
  imageClassName?: string
}): React.JSX.Element {
  if (application.icon?.type === 'bundled') {
    const Glyph = getOpenInAppIconGlyph(application.icon.id)
    return <Glyph width={size} height={size} className="shrink-0" />
  }

  if (application.icon?.type === 'image') {
    return (
      <img
        src={application.icon.src}
        width={size}
        height={size}
        alt=""
        aria-hidden
        // Why: a class, not an inline style — inline radius would win over any
        // override a caller passes in.
        className={cn('shrink-0 rounded-[2px] object-contain', imageClassName)}
      />
    )
  }

  const preset = getOpenInAppPreset(application)
  if (preset) {
    return (
      <img
        src={`https://www.google.com/s2/favicons?domain=${preset.faviconDomain}&sz=64`}
        width={size}
        height={size}
        alt=""
        aria-hidden
        className={cn('shrink-0', preset.iconClassName)}
        style={{ borderRadius: 2 }}
      />
    )
  }
  return <AppWindow width={size} height={size} />
}
