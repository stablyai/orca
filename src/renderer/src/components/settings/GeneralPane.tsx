import type React from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import { useAppStore } from '../../store'
import { Separator } from '../ui/separator'
import { CliSection } from './CliSection'
import { GeneralEditorSettingsSection } from './GeneralEditorSettingsSection'
import { GeneralSupportSection } from './GeneralSupportSection'
import { GeneralUpdateSettingsSection } from './GeneralUpdateSettingsSection'
import { GeneralWorkspaceSettingsSection } from './GeneralWorkspaceSettingsSection'
import {
  getGeneralCliSearchEntries,
  getGeneralEditorSearchEntries,
  getGeneralNavigationSearchEntries,
  getGeneralPaneSearchEntries,
  getGeneralSupportSearchEntries,
  getGeneralUpdateSearchEntries,
  getGeneralWorkspaceSearchEntries
} from './general-search'
import { getGeneralProjectRuntimeSearchEntries } from './general-project-runtime-search'
import { RecentTabOrderControl } from './RecentTabOrderControl'
import { matchesSettingsSearch, type SettingsSearchEntry } from './settings-search'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSubsectionHeader, SettingsSwitchRow } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'
import { DefaultWindowsProjectRuntimeSetting } from './DefaultWindowsProjectRuntimeSetting'

export {
  createAutoSaveDelayDraftState,
  updateAutoSaveDelayDraftState,
  type AutoSaveDelayDraftState
} from './GeneralEditorSettingsSection'
export { shouldCommitOpenInApplicationsDraft } from './OpenInMenuSetting'

type GeneralSearchEntry = ReturnType<typeof getGeneralNavigationSearchEntries>[number]

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

/**
 * The Project Runtime section is Windows-only. Gate on the platform directly:
 * an empty search query makes matchesSettingsSearch return true even for an
 * empty entries array, which would otherwise render an orphaned header (the
 * inner control self-hides) on non-Windows hosts.
 */
export function shouldShowProjectRuntimeSection(
  wslSupportedPlatform: boolean | undefined,
  searchQuery: string,
  projectRuntimeSearchEntries: SettingsSearchEntry[]
): boolean {
  return (
    Boolean(wslSupportedPlatform) && matchesSettingsSearch(searchQuery, projectRuntimeSearchEntries)
  )
}

export function getTabOrderControlSearchKeywords(
  navigationEntries: GeneralSearchEntry[] = getGeneralNavigationSearchEntries()
): string[] {
  const tabOrderSearchEntry = navigationEntries[0]
  return tabOrderSearchEntry
    ? [
        tabOrderSearchEntry.title,
        tabOrderSearchEntry.description ?? '',
        ...(tabOrderSearchEntry.keywords ?? [])
      ]
    : []
}

const EMPTY_WSL_DISTROS: string[] = []

type GeneralPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  wslSupportedPlatform?: boolean
  wslAvailable?: boolean
  wslDistros?: string[]
  wslCapabilitiesLoading?: boolean
}

export function GeneralPane({
  settings,
  updateSettings,
  wslSupportedPlatform,
  wslAvailable,
  wslDistros = EMPTY_WSL_DISTROS,
  wslCapabilitiesLoading
}: GeneralPaneProps): React.JSX.Element {
  const searchQuery = useAppStore((s) => s.settingsSearchQuery)
  const generalNavigationSearchEntries = getGeneralNavigationSearchEntries()
  const tabOrderKeywords = getTabOrderControlSearchKeywords(generalNavigationSearchEntries)
  const projectRuntimeSearchEntries = wslSupportedPlatform
    ? getGeneralProjectRuntimeSearchEntries()
    : []

  const visibleSections = [
    matchesSettingsSearch(searchQuery, generalNavigationSearchEntries) ? (
      <section key="navigation" className="space-y-4">
        <SettingsSubsectionHeader
          title={translate('auto.components.settings.GeneralPane.d58fccfd84', 'Navigation')}
        />
        <RecentTabOrderControl
          ctrlTabOrderMode={settings.ctrlTabOrderMode ?? 'mru'}
          keywords={tabOrderKeywords}
          updateSettings={updateSettings}
        />
        <SearchableSetting
          title={translate(
            'auto.components.settings.GeneralPane.5cb5475664',
            'Confirm before closing pinned tabs'
          )}
          description={translate(
            'auto.components.settings.GeneralPane.36b2a5dc6d',
            'Show a confirmation dialog before a pinned tab is closed.'
          )}
          keywords={['pinned', 'tab', 'confirm', 'close']}
        >
          <SettingsSwitchRow
            label={translate(
              'auto.components.settings.GeneralPane.5cb5475664',
              'Confirm before closing pinned tabs'
            )}
            description={translate(
              'auto.components.settings.GeneralPane.36b2a5dc6d',
              'Show a confirmation dialog before a pinned tab is closed.'
            )}
            checked={settings.confirmClosePinnedTab ?? true}
            onChange={() =>
              updateSettings({ confirmClosePinnedTab: !(settings.confirmClosePinnedTab ?? true) })
            }
          />
        </SearchableSetting>
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, getGeneralWorkspaceSearchEntries()) ? (
      <GeneralWorkspaceSettingsSection
        key="workspace"
        settings={settings}
        updateSettings={updateSettings}
      />
    ) : null,
    shouldShowProjectRuntimeSection(
      wslSupportedPlatform,
      searchQuery,
      projectRuntimeSearchEntries
    ) ? (
      <section key="project-runtime" className="space-y-4">
        <SettingsSubsectionHeader
          title={translate(
            'auto.components.settings.GeneralPane.projectRuntime',
            'Project Runtime'
          )}
          description={translate(
            'auto.components.settings.GeneralPane.projectRuntimeDescription',
            'Default runtime for local Windows projects that do not override it.'
          )}
        />
        <DefaultWindowsProjectRuntimeSetting
          settings={settings}
          updateSettings={updateSettings}
          wslSupportedPlatform={Boolean(wslSupportedPlatform)}
          wslAvailable={Boolean(wslAvailable)}
          wslDistros={wslDistros}
          wslCapabilitiesLoading={Boolean(wslCapabilitiesLoading)}
        />
      </section>
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
        wslSupportedPlatform={wslSupportedPlatform}
        wslAvailable={wslAvailable}
        wslCapabilitiesLoading={wslCapabilitiesLoading}
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
