import { useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStateValue } from '@/store/retained-views/app-state-view'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { getLocalExecutionHostLabel } from '../../../../../shared/execution-host/execution-host'
import { Button } from '../../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../ui/dialog'
import { SettingsBadge, SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { matchesSettingsSearch } from '../search/settings-search'
import type { SettingsHostScope } from '../host-scope/settings-host-scope'
import { useHostBooleanSetting } from '../host-scope/use-host-boolean-setting'
import { getWorkspaceCleanupSettingsSearchParts } from './workspace-cleanup-settings-search'

/** The host that owns the workspaces deletes their chat history, so the switch reads and writes that host. */
export function WorkspaceCleanupChatHistorySetting({
  hostScope,
  settings,
  updateSettings,
  onChanged
}: {
  hostScope: SettingsHostScope
  settings: GlobalSettings | null
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void> | void
  /** The switch decides whether the host schedules runs, so the page reads its report again. */
  onChanged: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const query = useAppStateValue((state) => state.settingsSearchQuery)
  const search = getWorkspaceCleanupSettingsSearchParts().deleteChatHistory
  const environmentId = runtimeTargetEnvironmentId(hostScope.target)
  const hostName = useAppStateValue((state) =>
    environmentId
      ? state.runtimeEnvironments.find((entry) => entry.id === environmentId)?.name
      : null
  )
  const hostLabel = hostName ?? getLocalExecutionHostLabel()
  const { setting, update } = useHostBooleanSetting({
    owner: hostScope.target,
    settingKey: 'deleteChatHistoryWithWorkspace',
    localEnabled: settings?.deleteChatHistoryWithWorkspace === true,
    updateLocalSettings: updateSettings,
    updateFailedMessage: t(
      'components.settings.workspaceCleanup.chatHistory.updateFailed',
      "Couldn't update the setting on {{host}}.",
      { host: hostLabel }
    )
  })
  const [confirming, setConfirming] = useState(false)
  const save = (next: boolean): void => {
    void update(next).then(onChanged)
  }
  const enabled = setting.state === 'ready' && setting.enabled
  if (!matchesSettingsSearch(query, [search])) {
    return null
  }

  return (
    <SettingsGroup
      title={t('components.settings.workspaceCleanup.chatHistory.title', 'Chat history')}
    >
      <SearchableSetting {...search}>
        <SettingsSwitchRow
          label={
            <span className="inline-flex items-center gap-2">
              {search.title}
              <SettingsBadge>
                {t('components.settings.workspaceCleanup.rules.recommended', 'Recommended')}
              </SettingsBadge>
            </span>
          }
          description={
            setting.state === 'unsupported'
              ? t(
                  'components.settings.workspaceCleanup.chatHistory.unsupported',
                  'Update Orca on {{host}} to use this setting there.',
                  { host: hostLabel }
                )
              : search.description
          }
          checked={enabled}
          disabled={setting.state !== 'ready'}
          // Turning it on deletes history from workspaces deleted before now, so it asks first.
          onChange={() => (enabled ? save(false) : setConfirming(true))}
          ariaLabel={search.title}
        />
      </SearchableSetting>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent surface="security">
          <DialogHeader>
            <DialogTitle>
              {t(
                'components.settings.workspaceCleanup.chatHistory.confirmTitle',
                'Delete chat history from deleted workspaces?'
              )}
            </DialogTitle>
            <DialogDescription>
              {t(
                'components.settings.workspaceCleanup.chatHistory.confirmDescription',
                "Orca will delete Orca, Claude Code and Codex chats from workspaces that no longer exist, including ones deleted before today. Chats from workspaces you still have are kept. Deleted chats can't be recovered."
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              {t('components.settings.workspaceCleanup.enable.cancel', 'Cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirming(false)
                save(true)
              }}
            >
              {t('components.settings.workspaceCleanup.enable.turnOn', 'Turn on')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  )
}
