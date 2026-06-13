import type { ReactNode } from 'react'
import { Accessibility, Camera } from 'lucide-react'
import type {
  ComputerUsePermissionId,
  ComputerUsePermissionStatus
} from '../../../../shared/computer-use-permissions-types'
import { translate } from '@/i18n/i18n'

type PermissionDefinition = {
  id: ComputerUsePermissionId
  label: string
  description: string
  icon: ReactNode
}

export const COMPUTER_USE_PERMISSIONS: PermissionDefinition[] = [
  {
    id: 'accessibility',
    get label() {
      return translate('auto.components.settings.ComputerUsePane.6b5a2cd3a5', 'Accessibility')
    },
    get description() {
      return translate(
        'auto.components.settings.ComputerUsePane.4d03dec2d0',
        'Read app interface trees and perform requested actions.'
      )
    },
    icon: <Accessibility className="size-4" />
  },
  {
    id: 'screenshots',
    get label() {
      return translate('auto.components.settings.ComputerUsePane.07bbe4c4cb', 'Screenshots')
    },
    get description() {
      return translate(
        'auto.components.settings.ComputerUsePane.0c9a33f468',
        'Capture app windows so agents can inspect visual state.'
      )
    },
    icon: <Camera className="size-4" />
  }
]

export function getComputerUsePermissionStatusLabel(
  status: ComputerUsePermissionStatus | undefined
): string {
  switch (status) {
    case 'granted':
      return 'Granted'
    case 'unsupported':
      return 'macOS only'
    case 'not-granted':
    case undefined:
      return 'Not enabled'
  }
}

export function getComputerUsePermissionStatusClass(
  status: ComputerUsePermissionStatus | undefined
): string {
  if (status === 'granted') {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  }
  return 'border-border bg-muted text-muted-foreground'
}
