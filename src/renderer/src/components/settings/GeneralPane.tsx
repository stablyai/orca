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
  getGeneralCacheTimerSearchEntries,
  getGeneralCliSearchEntries,
  getGeneralEditorSearchEntries,
  getGeneralNavigationSearchEntries,
  getGeneralNetworkSearchEntries,
  getGeneralPaneSearchEntries,
  getGeneralSupportSearchEntries,
  getGeneralUpdateSearchEntries,
  getGeneralWorkspaceSearchEntries
} from './general-search'
import { RecentTabOrderControl } from './RecentTabOrderControl'
import { matchesSettingsSearch } from './settings-search'
import { SettingsSubsectionHeader } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'

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

export { getGeneralPaneSearchEntries }

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
    matchesSettingsSearch(searchQuery, getGeneralNavigationSearchEntries()) ? (
      <section key="navigation" className="space-y-4">
        <SettingsSubsectionHeader
          title={translate('auto.components.settings.GeneralPane.d58fccfd84', 'Navigation')}
        />
        <RecentTabOrderControl
          ctrlTabOrderMode={settings.ctrlTabOrderMode ?? 'mru'}
          keywords={getGeneralNavigationSearchEntries().flatMap((entry) => [
            entry.title,
            entry.description ?? '',
            ...(entry.keywords ?? [])
          ])}
          updateSettings={updateSettings}
        />
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, getGeneralWorkspaceSearchEntries()) ? (
      <GeneralWorkspaceSettingsSection
        key="workspace"
        settings={settings}
        updateSettings={updateSettings}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, getGeneralNetworkSearchEntries()) ? (
      <GeneralNetworkSettingsSection
        key="network"
        settings={settings}
        updateSettings={updateSettings}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, getGeneralEditorSearchEntries()) ? (
      <GeneralEditorSettingsSection
        key="editor"
        settings={settings}
        updateSettings={updateSettings}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, getGeneralCliSearchEntries()) ? (
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
    matchesSettingsSearch(searchQuery, getGeneralCacheTimerSearchEntries()) ? (
      <GeneralCacheTimerSection
        key="cache-timer"
        settings={settings}
        updateSettings={updateSettings}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, getGeneralUpdateSearchEntries()) ? (
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
      {matchesSettingsSearch(searchQuery, getGeneralSupportSearchEntries()) ? (
        <GeneralSupportSection hasPrecedingSections={visibleSections.length > 0} />
      ) : null}
    </div>
  )
}
