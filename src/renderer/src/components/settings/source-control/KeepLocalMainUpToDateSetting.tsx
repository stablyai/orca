import { Trans } from 'react-i18next'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { Label } from '../../ui/label'
import { Switch } from '../../ui/switch'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import type { SettingsHostScope } from '../host-scope/settings-host-scope'
import {
  getHostSettingUnsupportedNote,
  getHostSettingUpdateFailedMessage,
  useHostSetting,
  useSettingsHostLabel
} from '../host-scope/use-host-setting'
import {
  KEEP_LOCAL_MAIN_UP_TO_DATE_SECTION_ID,
  getKeepLocalMainUpToDateTitle
} from './keep-local-main-up-to-date-setting'
import { i18n } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'

export const KEEP_LOCAL_MAIN_UP_TO_DATE_DESCRIPTION =
  'When you create a workspace, Orca refreshes the remote base and safely fast-forwards your matching local branch, such as main or master. This keeps commands like git diff main...HEAD from comparing against stale history. Orca skips the update if that branch has uncommitted changes or local-only commits.'
export const KEEP_LOCAL_MAIN_UP_TO_DATE_KEYWORDS = [
  'main',
  'master',
  'origin/main',
  'git diff',
  'behind main',
  'up to date',
  'stale main',
  'refresh local main',
  'base ref',
  'fresh base',
  'safely',
  'worktree'
]

/** The host that creates a workspace refreshes its local base, so the switch reads and writes that host. */
export function KeepLocalMainUpToDateSetting({
  hostScope,
  settings,
  updateSettings
}: {
  hostScope: SettingsHostScope
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): React.JSX.Element {
  const t = useTranslate()
  const title = getKeepLocalMainUpToDateTitle(t)
  const hostLabel = useSettingsHostLabel(hostScope.target)
  const { setting, update } = useHostSetting({
    owner: hostScope.target,
    settingKey: 'refreshLocalBaseRefOnWorktreeCreate',
    localSettings: settings,
    updateLocalSettings: updateSettings,
    updateFailedMessage: getHostSettingUpdateFailedMessage(hostLabel, t)
  })
  return (
    <SearchableSetting
      id={KEEP_LOCAL_MAIN_UP_TO_DATE_SECTION_ID}
      title={title}
      description={KEEP_LOCAL_MAIN_UP_TO_DATE_DESCRIPTION}
      keywords={KEEP_LOCAL_MAIN_UP_TO_DATE_KEYWORDS}
      className="flex items-center justify-between gap-4 py-3"
    >
      <div className="space-y-0.5">
        <Label>{title}</Label>
        <p className="text-xs text-muted-foreground">
          {setting.state === 'unsupported' ? (
            getHostSettingUnsupportedNote(hostLabel, t)
          ) : (
            <Trans
              i18n={i18n}
              defaults={t(
                'auto.components.settings.GitPane.refreshLocalBaseDescription',
                'When you create a workspace, Orca refreshes the remote base and safely fast-forwards your matching local branch, such as <mainBranch>main</mainBranch> or <masterBranch>master</masterBranch>. This keeps commands like <diffCommand>git diff main...HEAD</diffCommand> from comparing against stale history. Orca skips the update if that branch has uncommitted changes or local-only commits.'
              )}
              components={{
                mainBranch: <code />,
                masterBranch: <code />,
                diffCommand: <code />
              }}
            />
          )}
        </p>
      </div>
      <Switch
        aria-label={title}
        checked={setting.state === 'ready' && setting.value}
        disabled={setting.state !== 'ready' || !hostScope.available}
        onCheckedChange={(checked) => void update(checked)}
      />
    </SearchableSetting>
  )
}
