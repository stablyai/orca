import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { Button } from '@/components/ui/button'
import { BROWSER_SSH_WORKSPACE_ROUTING_SETTINGS_TARGET_ID } from '@/lib/settings-navigation-types'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { SettingsRow, SettingsSegmentedControl } from '../../form-controls/SettingsFormControls'
import {
  getBrowserSshWorkspaceRoutingDescription,
  getBrowserSshWorkspaceRoutingTitle
} from './browser-ssh-workspace-routing-copy'

type BrowserSshWorkspaceRoutingSettingProps = {
  settings: Pick<
    GlobalSettings,
    'browserSshWorkspaceRoutingEnabled' | 'browserSshWorkspaceRoutingDisabledTargetIds'
  >
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function BrowserSshWorkspaceRoutingSetting({
  settings,
  updateSettings
}: BrowserSshWorkspaceRoutingSettingProps): React.JSX.Element {
  const t = useTranslate()
  const title = getBrowserSshWorkspaceRoutingTitle(t)
  const description = getBrowserSshWorkspaceRoutingDescription(t)
  const sshTargetLabels = useAppStore((s) => s.sshTargetLabels)
  const disabledTargetIds = settings.browserSshWorkspaceRoutingDisabledTargetIds ?? []

  return (
    <SearchableSetting
      id={BROWSER_SSH_WORKSPACE_ROUTING_SETTINGS_TARGET_ID}
      title={title}
      description={description}
      keywords={[
        'browser',
        'ssh',
        'remote',
        'proxy',
        'tunnel',
        'routing',
        'host',
        'network',
        'egress',
        'traffic'
      ]}
    >
      <SettingsRow
        label={title}
        description={description}
        control={
          <SettingsSegmentedControl
            size="sm"
            ariaLabel={title}
            // Older profiles omit the flag and default SSH workspaces to routed egress.
            value={settings.browserSshWorkspaceRoutingEnabled !== false ? 'host' : 'device'}
            onChange={(value) =>
              updateSettings({ browserSshWorkspaceRoutingEnabled: value === 'host' })
            }
            options={[
              {
                value: 'host',
                label: t('settings.browser.sshWorkspaceRouting.optionHost', 'SSH host'),
                tooltip: t(
                  'settings.browser.sshWorkspaceRouting.optionHostTooltip',
                  "Traffic and DNS go through the workspace's SSH host."
                )
              },
              {
                value: 'device',
                label: t('settings.browser.sshWorkspaceRouting.optionDevice', 'This device'),
                tooltip: t(
                  'settings.browser.sshWorkspaceRouting.optionDeviceTooltip',
                  "Pages browse from this machine's network."
                )
              }
            ]}
          />
        }
      />
      {disabledTargetIds.length > 0 ? (
        <div className="mt-2 flex flex-col gap-1.5">
          <div className="text-xs text-muted-foreground">
            {t(
              'settings.browser.sshWorkspaceRouting.disabledHosts',
              'Hosts browsing from this device instead:'
            )}
          </div>
          {disabledTargetIds.map((targetId) => (
            <div key={targetId} className="flex items-center gap-2 text-xs text-foreground">
              <span className="min-w-0 truncate">{sshTargetLabels.get(targetId) ?? targetId}</span>
              <Button
                type="button"
                variant="link"
                size="xs"
                className="h-auto px-0"
                onClick={() =>
                  updateSettings({
                    browserSshWorkspaceRoutingDisabledTargetIds: disabledTargetIds.filter(
                      (id) => id !== targetId
                    )
                  })
                }
              >
                {t('settings.browser.sshWorkspaceRouting.useHost', 'Use SSH host')}
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </SearchableSetting>
  )
}
