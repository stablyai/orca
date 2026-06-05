import type React from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import { useAppStore } from '../../store'
import { Separator } from '../ui/separator'
import { CliSection } from './CliSection'
import { GeneralCacheTimerSection } from './GeneralCacheTimerSection'
import { GeneralEditorSettingsSection } from './GeneralEditorSettingsSection'
import { GeneralNetworkSettingsSection } from './GeneralNetworkSettingsSection'
import { GeneralSupportSection } from './GeneralSupportSection'
import { GeneralUpdateSettingsSection } from './GeneralUpdateSettingsSection'
import { GeneralWorkspaceSettingsSection } from './GeneralWorkspaceSettingsSection'
import {
  GENERAL_CACHE_TIMER_SEARCH_ENTRIES,
  GENERAL_CLI_SEARCH_ENTRIES,
  GENERAL_EDITOR_SEARCH_ENTRIES,
  GENERAL_NAVIGATION_SEARCH_ENTRIES,
  GENERAL_NETWORK_SEARCH_ENTRIES,
  GENERAL_PANE_SEARCH_ENTRIES,
  GENERAL_SUPPORT_SEARCH_ENTRIES,
  GENERAL_UPDATE_SEARCH_ENTRIES,
  GENERAL_WORKSPACE_SEARCH_ENTRIES
} from './general-search'
import { RecentTabOrderControl } from './RecentTabOrderControl'
import { matchesSettingsSearch } from './settings-search'
import { SettingsSubsectionHeader } from './SettingsFormControls'

export {
  createAutoSaveDelayDraftState,
  updateAutoSaveDelayDraftState,
  type AutoSaveDelayDraftState
} from './GeneralEditorSettingsSection'
export {
  createHttpProxyBypassRulesDraftState,
  createHttpProxyUrlDraftState,
  setHttpProxyUrlDraftErrorState,
  updateHttpProxyBypassRulesDraftState,
  updateHttpProxyUrlDraftState,
  type HttpProxyBypassRulesDraftState,
  type HttpProxyUrlDraftState
} from './GeneralNetworkSettingsSection'
export { shouldCommitOpenInApplicationsDraft } from './OpenInMenuSetting'

export function getDesktopPlatformFromUserAgent(userAgent: string): 'darwin' | 'win32' | 'other' {
  if (userAgent.includes('Mac')) {
    return 'darwin'
  }
  if (userAgent.includes('Windows')) {
    return 'win32'
  }
  return 'other'
}

export { GENERAL_PANE_SEARCH_ENTRIES }

type GeneralPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  wslSupportedPlatform?: boolean
  wslAvailable?: boolean
  wslCapabilitiesLoading?: boolean
}

export function GeneralPane({
  settings,
  updateSettings,
  wslSupportedPlatform,
  wslAvailable,
  wslCapabilitiesLoading
}: GeneralPaneProps): React.JSX.Element {
  const searchQuery = useAppStore((s) => s.settingsSearchQuery)

  const visibleSections = [
    matchesSettingsSearch(searchQuery, GENERAL_NAVIGATION_SEARCH_ENTRIES) ? (
      <section key="navigation" className="space-y-4">
        <SettingsSubsectionHeader title="Navigation" />
        <RecentTabOrderControl
          ctrlTabOrderMode={settings.ctrlTabOrderMode ?? 'mru'}
          keywords={GENERAL_NAVIGATION_SEARCH_ENTRIES.flatMap((entry) => [
            entry.title,
            entry.description ?? '',
            ...(entry.keywords ?? [])
          ])}
          updateSettings={updateSettings}
        />
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, GENERAL_WORKSPACE_SEARCH_ENTRIES) ? (
      <GeneralWorkspaceSettingsSection
        key="workspace"
        settings={settings}
        updateSettings={updateSettings}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, GENERAL_NETWORK_SEARCH_ENTRIES) ? (
      <GeneralNetworkSettingsSection
        key="network"
        settings={settings}
        updateSettings={updateSettings}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, GENERAL_EDITOR_SEARCH_ENTRIES) ? (
      <GeneralEditorSettingsSection
        key="editor"
        settings={settings}
        updateSettings={updateSettings}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, GENERAL_CLI_SEARCH_ENTRIES) ? (
      <CliSection
        key="cli"
        currentPlatform={getDesktopPlatformFromUserAgent(navigator.userAgent)}
        settings={settings}
        updateSettings={updateSettings}
        wslSupportedPlatform={wslSupportedPlatform}
        wslAvailable={wslAvailable}
        wslCapabilitiesLoading={wslCapabilitiesLoading}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, GENERAL_CACHE_TIMER_SEARCH_ENTRIES) ? (
      <GeneralCacheTimerSection
        key="cache-timer"
        settings={settings}
        updateSettings={updateSettings}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, GENERAL_UPDATE_SEARCH_ENTRIES) ? (
      <GeneralUpdateSettingsSection key="updates" />
    ) : null
    // Note: the Support section is rendered outside this array so it can own
    // its own loading placeholder and its own collapsing Separator. Without
    // that separation, a dangling divider would remain above the collapsed
    // section.
  ].filter(Boolean)

  return (
    <div className="space-y-6">
      {visibleSections.map((section, index) => (
        <div key={index} className="space-y-6">
          {index > 0 ? <Separator /> : null}
          {section}
        </div>
      ))}
      {matchesSettingsSearch(searchQuery, GENERAL_SUPPORT_SEARCH_ENTRIES) ? (
        <GeneralSupportSection hasPrecedingSections={visibleSections.length > 0} />
      ) : null}
    </div>
  )
}
