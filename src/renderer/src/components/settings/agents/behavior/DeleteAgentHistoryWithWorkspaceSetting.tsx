import { useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { useAppStateValue } from '@/store/retained-views/app-state-view'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import { Button } from '../../../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../ui/tooltip'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../../ui/dialog'
import { SettingsBadge, SettingsSwitchRow } from '../../form-controls/SettingsFormControls'
import { SettingsTitleWithBadge } from '../../form-controls/SettingsTitleWithBadge'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import type { SettingsHostScope } from '../../host-scope/settings-host-scope'
import { useHostSetting, useSettingsHostLabel } from '../../host-scope/use-host-setting'
import { formatBytes } from '../../../../../../shared/text/format-bytes'
import { getDeleteAgentHistorySearchEntry } from './delete-agent-history-search'
import { useCodexHistoryDiskUsage } from './use-codex-history-disk-usage'
import { matchesSettingsSearch } from '../../search/settings-search'

/** The host that owns the workspaces deletes their chat history, so the switch reads and writes that host. */
export function DeleteAgentHistoryWithWorkspaceSetting({
  hostScope,
  settings
}: {
  hostScope: SettingsHostScope
  settings: GlobalSettings
}): React.JSX.Element {
  const t = useTranslate()
  const search = getDeleteAgentHistorySearchEntry()
  const updateSettingsOrThrow = useAppStore((state) => state.updateSettingsOrThrow)
  const hostLabel = useSettingsHostLabel(hostScope.target)
  const { setting, update } = useHostSetting({
    owner: hostScope.target,
    settingKey: 'deleteChatHistoryWithWorkspace',
    localSettings: settings,
    // The throwing variant, so a failed local save shows the toast instead of only logging.
    updateLocalSettings: updateSettingsOrThrow,
    updateFailedMessage: t(
      'components.settings.agents.deleteHistoryWithWorkspace.updateFailed',
      "Couldn't update the setting on {{host}}.",
      { host: hostLabel }
    )
  })
  const query = useAppStateValue((state) => state.settingsSearchQuery)
  // The row stays mounted while search hides it, so the size is read only when it can be seen.
  const diskUsage = useCodexHistoryDiskUsage(hostScope.target, matchesSettingsSearch(query, search))
  const [confirming, setConfirming] = useState(false)
  const enabled = setting.state === 'ready' && setting.value
  const historySize =
    diskUsage && diskUsage.rollouts > 0 && setting.state !== 'unsupported'
      ? formatBytes(diskUsage.bytes)
      : null

  return (
    <>
      <SearchableSetting {...search}>
        <SettingsSwitchRow
          label={
            <SettingsTitleWithBadge
              title={<span className="inline-block align-middle">{search.title}</span>}
              badge={t(
                'components.settings.agents.deleteHistoryWithWorkspace.recommended',
                'Recommended'
              )}
            >
              {historySize && diskUsage ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    {/* Focusable so keyboard users reach the explanation too. */}
                    <span
                      tabIndex={0}
                      className="ml-2 inline-flex rounded-full align-middle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <SettingsBadge tone="muted" className="wrap-anywhere">
                        {diskUsage.complete
                          ? t(
                              'components.settings.agents.deleteHistoryWithWorkspace.codexHistoryBadge',
                              'Codex history: {{size}}',
                              { size: historySize }
                            )
                          : t(
                              'components.settings.agents.deleteHistoryWithWorkspace.codexHistoryBadgeAtLeast',
                              'Codex history: {{size}}+',
                              { size: historySize }
                            )}
                      </SettingsBadge>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-72">
                    {diskUsage.complete
                      ? t(
                          'components.settings.agents.deleteHistoryWithWorkspace.codexHistoryTooltip',
                          'Space Codex uses for its own chat history on {{host}}, including chats from workspaces you still have.',
                          { host: hostLabel }
                        )
                      : t(
                          'components.settings.agents.deleteHistoryWithWorkspace.codexHistoryTooltipAtLeast',
                          'Codex uses at least this much space for its own chat history on {{host}}, including chats from workspaces you still have.',
                          { host: hostLabel }
                        )}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </SettingsTitleWithBadge>
          }
          description={
            setting.state === 'unsupported'
              ? t(
                  'components.settings.agents.deleteHistoryWithWorkspace.unsupported',
                  'Update Orca on {{host}} to use this setting there.',
                  { host: hostLabel }
                )
              : search.description
          }
          checked={enabled}
          disabled={setting.state !== 'ready' || !hostScope.available}
          // Turning it on deletes history from workspaces deleted before now, so it asks first.
          onChange={() => (enabled ? void update(false) : setConfirming(true))}
          ariaLabel={search.title}
        />
      </SearchableSetting>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent surface="security">
          <DialogHeader>
            <DialogTitle>
              {t(
                'components.settings.agents.deleteHistoryWithWorkspace.confirmTitle',
                'Delete agent history from deleted workspaces?'
              )}
            </DialogTitle>
            <DialogDescription>
              {t(
                'components.settings.agents.deleteHistoryWithWorkspace.confirmDescription',
                "Orca will delete Orca, Claude Code and Codex chats from workspaces that no longer exist, including ones deleted before today. Chats from workspaces you still have are kept. Deleted chats can't be recovered."
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              {t('components.settings.agents.deleteHistoryWithWorkspace.cancel', 'Cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirming(false)
                void update(true)
              }}
            >
              {t('components.settings.agents.deleteHistoryWithWorkspace.turnOn', 'Turn on')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
