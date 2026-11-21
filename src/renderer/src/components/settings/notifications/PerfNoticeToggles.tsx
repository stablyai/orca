import { Globe, HardDrive } from 'lucide-react'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import {
  isPerfNoticeOff,
  type PerfNoticeId
} from '../../../../../shared/perf-notices/perf-notice-settings'
import { setPerfNoticeOff } from '@/components/perf-notices/perf-notice-opt-out'
import { useTranslate } from '@/i18n/use-translate'
import { NotificationSettingToggle } from './NotificationSettingToggle'

/** In-app perf warnings; each one's Don't show again turns its row off here. */
export function PerfNoticeToggles({ settings }: { settings: GlobalSettings }): React.JSX.Element {
  const t = useTranslate()
  const toggle = (id: PerfNoticeId): void =>
    void setPerfNoticeOff(id, !isPerfNoticeOff(settings, id))
  return (
    <>
      <NotificationSettingToggle
        icon={<HardDrive className="size-4" />}
        label={t('settings.notifications.perfNotices.disk.label', 'Disk almost full')}
        description={t(
          'settings.notifications.perfNotices.disk.description',
          'Suggest cleaning up workspaces when your disk is almost full.'
        )}
        checked={!isPerfNoticeOff(settings, 'disk-almost-full')}
        onToggle={() => toggle('disk-almost-full')}
      />
      <NotificationSettingToggle
        icon={<Globe className="size-4" />}
        label={t('settings.notifications.perfNotices.hiddenTabs.label', 'Hidden browser tabs')}
        description={t(
          'settings.notifications.perfNotices.hiddenTabs.description',
          'Suggest Memory Saver when many hidden browser tabs stay loaded.'
        )}
        checked={!isPerfNoticeOff(settings, 'hidden-browser-tabs')}
        onToggle={() => toggle('hidden-browser-tabs')}
      />
    </>
  )
}
