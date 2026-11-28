import type React from 'react'
import { AppWindow } from 'lucide-react'
import type { OpenInApplication } from '../../../../../shared/ui-chrome/ui-chrome-types'
import antigravityIconUrl from '../../../../../shared/agent-icons/antigravity.png?url'
import cursorIconUrl from '../../../../../shared/agent-icons/cursor.png?url'
import devinIconUrl from '../../../../../shared/agent-icons/devin.png?url'
import vscodeIconUrl from '@/assets/editor-brands/vscode.png?url'
import zedIconUrl from '@/assets/editor-brands/zed.png?url'
import { cn } from '../../class-names'
import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { BUILT_IN_EDITOR_COMMANDS } from '../../../../../shared/editor/launch/open-in-applications'

export type OpenInAppPreset = {
  id: string
  label: string
  command: string
  iconUrl: string
  iconClassName?: string
}

export const getOpenInAppPresets = createLocalizedCatalog(() => [
  {
    id: 'vscode',
    label: translate('auto.lib.open.in.app.catalog.173553f73a', 'VS Code'),
    command: BUILT_IN_EDITOR_COMMANDS.vscode,
    iconUrl: vscodeIconUrl
  },
  {
    id: 'cursor',
    label: translate('auto.lib.open.in.app.catalog.d62b12e98a', 'Cursor'),
    command: BUILT_IN_EDITOR_COMMANDS.cursor,
    iconUrl: cursorIconUrl
  },
  {
    id: 'zed',
    label: translate('auto.lib.open.in.app.catalog.f8b8ca2711', 'Zed'),
    command: BUILT_IN_EDITOR_COMMANDS.zed,
    iconUrl: zedIconUrl,
    // Why: Zed's mark is black on transparent, so it disappears on dark menus.
    iconClassName: 'dark:invert'
  },
  {
    id: 'devin-desktop',
    label: translate('settings.openInApp.preset.devinDesktop', 'Devin Desktop'),
    command: BUILT_IN_EDITOR_COMMANDS['devin-desktop'],
    iconUrl: devinIconUrl
  },
  {
    id: 'antigravity-ide',
    label: translate('settings.openInApp.preset.antigravityIde', 'Antigravity IDE'),
    command: BUILT_IN_EDITOR_COMMANDS['antigravity-ide'],
    iconUrl: antigravityIconUrl
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
  size = 14
}: {
  application: Pick<OpenInApplication, 'command'>
  size?: number
}): React.JSX.Element {
  const preset = getOpenInAppPreset(application)
  if (preset) {
    return (
      <img
        src={preset.iconUrl}
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
