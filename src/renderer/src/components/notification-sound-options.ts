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

export type NotificationSoundOption = {
  id: GlobalSettings['notifications']['customSoundId']
  title: string
  icon: LucideIcon
}

export const BUILT_IN_NOTIFICATION_SOUND_OPTIONS: readonly NotificationSoundOption[] = [
  {
    id: 'system',
    title: 'System Default',
    icon: Bell
  },
  {
    id: 'two-tone',
    title: 'Two Tone',
    icon: AudioWaveform
  },
  {
    id: 'bong',
    title: 'Bong',
    icon: CircleDot
  },
  {
    id: 'thump',
    title: 'Thump',
    icon: Volume1
  },
  {
    id: 'blip',
    title: 'Blip',
    icon: Zap
  },
  {
    id: 'sonar',
    title: 'Sonar',
    icon: Radar
  },
  {
    id: 'blop',
    title: 'Blop',
    icon: Activity
  },
  {
    id: 'ding',
    title: 'Ding',
    icon: Radio
  },
  {
    id: 'clack',
    title: 'Clack',
    icon: Keyboard
  },
  {
    id: 'beep',
    title: 'Beep',
    icon: MousePointer2
  }
]

export function getNotificationSoundOptions(
  customPath: string | null | undefined
): readonly NotificationSoundOption[] {
  if (!customPath) {
    return BUILT_IN_NOTIFICATION_SOUND_OPTIONS
  }

  return [
    ...BUILT_IN_NOTIFICATION_SOUND_OPTIONS,
    {
      id: 'custom',
      title: basename(customPath),
      icon: FileAudio
    }
  ]
}
