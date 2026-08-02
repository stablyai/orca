import {
  Activity,
  AudioWaveform,
  Bell,
  CircleDot,
  FileAudio,
  Keyboard,
  MousePointer2,
  Radio,
  Radar,
  Volume1,
  Zap,
  type LucideIcon
} from 'lucide-react'
import { basename } from '@/lib/path'
import type { GlobalSettings } from '../../../shared/types'
import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export type NotificationSoundOption = {
  id: GlobalSettings['notifications']['customSoundId']
  title: string
  icon: LucideIcon
}

export const getBuiltInNotificationSoundOptions = createLocalizedCatalog(
  (): NotificationSoundOption[] => [
    {
      id: 'system',
      title: translate('auto.components.notification.sound.options.017abebfa6', 'System Default'),
      icon: Bell
    },
    {
      id: 'two-tone',
      title: translate('auto.components.notification.sound.options.80f7cc95b3', 'Two Tone'),
      icon: AudioWaveform
    },
    {
      id: 'bong',
      title: translate('auto.components.notification.sound.options.86af8d938c', 'Bong'),
      icon: CircleDot
    },
    {
      id: 'thump',
      title: translate('auto.components.notification.sound.options.1e4b81d892', 'Thump'),
      icon: Volume1
    },
    {
      id: 'blip',
      title: translate('auto.components.notification.sound.options.588c90487d', 'Blip'),
      icon: Zap
    },
    {
      id: 'sonar',
      title: translate('auto.components.notification.sound.options.020826ef17', 'Sonar'),
      icon: Radar
    },
    {
      id: 'blop',
      title: translate('auto.components.notification.sound.options.2b44847d8d', 'Blop'),
      icon: Activity
    },
    {
      id: 'ding',
      title: translate('auto.components.notification.sound.options.79919c832d', 'Ding'),
      icon: Radio
    },
    {
      id: 'clack',
      title: translate('auto.components.notification.sound.options.0acd3d384e', 'Clack'),
      icon: Keyboard
    },
    {
      id: 'beep',
      title: translate('auto.components.notification.sound.options.e38b0a2e68', 'Beep'),
      icon: MousePointer2
    }
  ]
)

export function getNotificationSoundOptions(
  customPath: string | null | undefined
): readonly NotificationSoundOption[] {
  if (!customPath) {
    return getBuiltInNotificationSoundOptions()
  }

  return [
    ...getBuiltInNotificationSoundOptions(),
    {
      id: 'custom',
      title: basename(customPath),
      icon: FileAudio
    }
  ]
}
