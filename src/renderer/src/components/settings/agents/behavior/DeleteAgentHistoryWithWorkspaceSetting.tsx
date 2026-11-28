import { useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { useAppStateValue } from '@/store/retained-views/app-state-view'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import type { HostOwnedSettingKey } from '../../../../../../shared/settings/host-owned-settings'
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
import {
  getDeleteAgentHistorySearchEntry,
  getDeleteOrcaChatsSearchEntry
} from './delete-agent-history-search'
import { useCodexHistoryDiskUsage } from './use-codex-history-disk-usage'
import { matchesSettingsSearch } from '../../search/settings-search'

type HistorySettingProps = { hostScope: SettingsHostScope; settings: GlobalSettings }

/** The host that owns the workspaces deletes their chat history, so each switch reads and writes that host. */
export function DeleteAgentHistoryWithWorkspaceSetting(
  props: HistorySettingProps
): React.JSX.Element {
  return (
    <>
      <DeleteOrcaChatsSwitch {...props} />
      <DeleteCliHistorySwitch {...props} />
    </>
  )
}

function DeleteOrcaChatsSwitch(props: HistorySettingProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <HistoryDeletionSwitch
      {...props}
      settingKey="deleteOrcaChatsWithWorkspace"
      search={getDeleteOrcaChatsSearchEntry()}
      // An older host has only the combined switch: keep it visible so it can still be turned off.
      whenUnsupported={<LegacyCombinedHistorySwitch {...props} />}
      badge={t('components.settings.agents.deleteHistoryWithWorkspace.recommended', 'Recommended')}
      confirmTitle={t(
        'components.settings.agents.deleteHistoryWithWorkspace.orcaConfirmTitle',
        'Delete Orca chats from deleted workspaces?'
      )}
      confirmDescription={t(
        'components.settings.agents.deleteHistoryWithWorkspace.orcaConfirmDescription',
        "Orca will delete its chats from workspaces that no longer exist, including ones deleted before today. Chats from workspaces you still have are kept. Deleted chats can't be recovered."
      )}
    />
  )
}

function DeleteCliHistorySwitch(props: HistorySettingProps): React.JSX.Element {
  const t = useTranslate()
  const search = getDeleteAgentHistorySearchEntry()
  const hostLabel = useSettingsHostLabel(props.hostScope.target)
  const query = useAppStateValue((state) => state.settingsSearchQuery)
  // The row stays mounted while search hides it, so the size is read only when it can be seen.
  const diskUsage = useCodexHistoryDiskUsage(
    props.hostScope.target,
    matchesSettingsSearch(query, search)
  )
  const historySize = diskUsage && diskUsage.rollouts > 0 ? formatBytes(diskUsage.bytes) : null
  return (
    <HistoryDeletionSwitch
      {...props}
      settingKey="deleteAgentTranscriptsWithWorkspace"
      search={search}
      whenUnsupported={null}
      detail={
        historySize && diskUsage ? (
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
        ) : null
      }
      confirmTitle={t(
        'components.settings.agents.deleteHistoryWithWorkspace.cliConfirmTitle',
        'Delete Claude Code and Codex history from deleted workspaces?'
      )}
      confirmDescription={t(
        'components.settings.agents.deleteHistoryWithWorkspace.cliConfirmDescription',
        "Orca will delete Claude Code and Codex chats from workspaces that no longer exist, including ones deleted before today. Chats from workspaces you still have are kept. Deleted chats can't be recovered."
      )}
    />
  )
}

/** The single switch hosts before the split read: Orca, Claude Code and Codex history together. */
function LegacyCombinedHistorySwitch(props: HistorySettingProps): React.JSX.Element {
  const t = useTranslate()
  const search = getDeleteOrcaChatsSearchEntry()
  return (
    <HistoryDeletionSwitch
      {...props}
      settingKey="deleteChatHistoryWithWorkspace"
      search={{
        ...search,
        title: t(
          'components.settings.agents.deleteHistoryWithWorkspace.legacyTitle',
          'Delete agent history when a workspace is deleted'
        ),
        description: t(
          'components.settings.agents.deleteHistoryWithWorkspace.legacyDescription',
          "Orca, Claude Code and Codex chats from deleted workspaces are removed automatically to free disk space. They can't be recovered."
        )
      }}
      confirmTitle={t(
        'components.settings.agents.deleteHistoryWithWorkspace.legacyConfirmTitle',
        'Delete agent history from deleted workspaces?'
      )}
      confirmDescription={t(
        'components.settings.agents.deleteHistoryWithWorkspace.legacyConfirmDescription',
        "Orca will delete Orca, Claude Code and Codex chats from workspaces that no longer exist, including ones deleted before today. Chats from workspaces you still have are kept. Deleted chats can't be recovered."
      )}
    />
  )
}

function HistoryDeletionSwitch({
  hostScope,
  settings,
  settingKey,
  search,
  badge,
  detail,
  confirmTitle,
  confirmDescription,
  whenUnsupported
}: HistorySettingProps & {
  settingKey: Extract<
    HostOwnedSettingKey,
    | 'deleteOrcaChatsWithWorkspace'
    | 'deleteAgentTranscriptsWithWorkspace'
    | 'deleteChatHistoryWithWorkspace'
  >
  /** What a host that predates this switch shows instead (null hides the row); absent shows "Update Orca". */
  whenUnsupported?: React.JSX.Element | null
  search: { title: string; description: string; keywords: string[] }
  badge?: string
  detail?: React.ReactNode
  confirmTitle: string
  confirmDescription: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const updateSettingsOrThrow = useAppStore((state) => state.updateSettingsOrThrow)
  const hostLabel = useSettingsHostLabel(hostScope.target)
  const { setting, update } = useHostSetting({
    owner: hostScope.target,
    settingKey,
    localSettings: settings,
    // The throwing variant, so a failed local save shows the toast instead of only logging.
    updateLocalSettings: updateSettingsOrThrow,
    updateFailedMessage: t(
      'components.settings.agents.deleteHistoryWithWorkspace.updateFailed',
      "Couldn't update the setting on {{host}}.",
      { host: hostLabel }
    )
  })
  const [confirming, setConfirming] = useState(false)
  const enabled = setting.state === 'ready' && setting.value
  if (setting.state === 'unsupported' && whenUnsupported !== undefined) {
    return whenUnsupported
  }

  return (
    <>
      <SearchableSetting {...search}>
        <SettingsSwitchRow
          label={
            <SettingsTitleWithBadge
              title={<span className="inline-block align-middle">{search.title}</span>}
              badge={badge}
            >
              {setting.state === 'unsupported' ? null : detail}
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
            <DialogTitle>{confirmTitle}</DialogTitle>
            <DialogDescription>{confirmDescription}</DialogDescription>
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
