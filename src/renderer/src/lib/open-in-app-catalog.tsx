import type React from 'react'
import { AppWindow } from 'lucide-react'
import type { OpenInApplication } from '../../../shared/types'
import { cn } from './utils'
import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import antigravityIcon from '../../../../resources/antigravity.png?url'

export type OpenInAppPreset = {
  id: string
  label: string
  command: string
  // One of these supplies the icon: a bundled asset URL, or a domain whose
  // favicon is fetched through Google's service.
  iconUrl?: string
  faviconDomain?: string
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
  },
  {
    id: 'antigravity',
    label: translate('auto.lib.open.in.app.catalog.f0fb1adb49', 'Antigravity'),
    command: 'antigravity',
    // Why: Google's favicon service is unreliable for antigravity.google
    // (intermittent 301/empty), so ship the mark as a bundled asset instead.
    iconUrl: antigravityIcon
  }
])

/** Find the built-in preset matching an application's command (case/space-insensitive), or null. */
export function getOpenInAppPreset(
  application: Pick<OpenInApplication, 'command'>
): OpenInAppPreset | null {
  const command = application.command.trim().toLowerCase()
  return getOpenInAppPresets().find((preset) => preset.command === command) ?? null
}

/** Whether a preset's command is already present in the given list of configured applications. */
export function isOpenInAppPresetAdded(
  applications: readonly Pick<OpenInApplication, 'command'>[],
  preset: OpenInAppPreset
): boolean {
  return applications.some(
    (application) => application.command.trim().toLowerCase() === preset.command
  )
}

/** Render an application's icon — bundled asset or Google favicon for a known preset, else a generic window icon. */
export function OpenInApplicationIcon({
  application,
  size = 14
}: {
  application: Pick<OpenInApplication, 'command'>
  size?: number
}): React.JSX.Element {
  const preset = getOpenInAppPreset(application)
  if (preset) {
    return (
      <img
        src={
          preset.iconUrl ??
          `https://www.google.com/s2/favicons?domain=${preset.faviconDomain}&sz=64`
        }
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
