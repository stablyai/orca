import type React from 'react'
import { AppWindow } from 'lucide-react'
import type { OpenInApplication } from '../../../shared/types'

export type OpenInAppPreset = {
  id: string
  label: string
  command: string
  faviconDomain: string
}

export const OPEN_IN_APP_PRESETS: OpenInAppPreset[] = [
  {
    id: 'vscode',
    label: 'VS Code',
    command: 'code',
    faviconDomain: 'code.visualstudio.com'
  },
  { id: 'cursor', label: 'Cursor', command: 'cursor', faviconDomain: 'cursor.com' },
  { id: 'zed', label: 'Zed', command: 'zed', faviconDomain: 'zed.dev' }
]

export function getOpenInAppPreset(
  application: Pick<OpenInApplication, 'command'>
): OpenInAppPreset | null {
  const command = application.command.trim().toLowerCase()
  return OPEN_IN_APP_PRESETS.find((preset) => preset.command === command) ?? null
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
        src={`https://www.google.com/s2/favicons?domain=${preset.faviconDomain}&sz=64`}
        width={size}
        height={size}
        alt=""
        aria-hidden
        style={{ borderRadius: 2 }}
      />
    )
  }
  return <AppWindow width={size} height={size} />
}
