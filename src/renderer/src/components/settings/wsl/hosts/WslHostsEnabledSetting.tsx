import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { Label } from '../../../ui/label'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { Switch } from '@/components/ui/switch'
import { getWslHostsSearchEntry } from './wsl-hosts-search'
import { isWslHostsSettingOn } from '../../../../../../shared/remote-runtime/wsl-hosts/wsl-hosts-setting'

/** The user's kill switch for WSL hosts; on by default. */
export function WslHostsEnabledSetting(): React.JSX.Element {
  const t = useTranslate()
  const entry = getWslHostsSearchEntry()
  const enabled = useAppStore((s) => isWslHostsSettingOn(s.settings))
  const updateSettings = useAppStore((s) => s.updateSettings)
  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
      className="flex items-start justify-between gap-4 py-3"
      id="wsl-hosts"
    >
      <div className="min-w-0 shrink space-y-0.5">
        <Label>{entry.title}</Label>
        <p className="text-xs text-muted-foreground">{entry.description}</p>
      </div>
      <Switch
        checked={enabled}
        aria-label={t(
          'auto.components.settings.wslHostsExperimental.toggleLabel',
          'Toggle WSL distros as hosts'
        )}
        onCheckedChange={(checked) => void updateSettings({ experimentalWslHosts: checked })}
      />
    </SearchableSetting>
  )
}
