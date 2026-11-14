import type React from 'react'
import { useEffect, useRef } from 'react'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { useAppStore } from '../../../store/index'
import { CliSection } from '../cli/install/CliSection'
import { GeneralEditorSettingsSection } from '../editor/GeneralEditorSettingsSection'
import { GeneralAutoSaveSetting } from '../editor/GeneralAutoSaveSetting'
import { GeneralSupportSection } from './GeneralSupportSection'
import { GeneralUpdateSettingsSection } from '../updates/GeneralUpdateSettingsSection'
import { GeneralWorkspaceSettingsSection } from './GeneralWorkspaceSettingsSection'
import {
  getGeneralCliSearchEntries,
  getGeneralNavigationSearchEntries,
  getGeneralUpdateSearchEntries
} from './general-search'
import { getGeneralEditorSearchDescriptors } from '../editor/general-editor-search'
import { getGeneralSupportSearchEntries } from './general-support-search'
import { getGeneralProjectRuntimeSearchEntries } from './project-runtime/general-project-runtime-search'
import { TabBarOrderControl } from '../appearance/TabBarOrderControl'
import { RecentTabOrderControl } from '../appearance/RecentTabOrderControl'
import { matchesSettingsSearch, type SettingsSearchEntry } from '../search/settings-search'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { SettingsNavigationRow } from '../form-controls/SettingsNavigationRow'
import { useTranslate } from '@/i18n/use-translate'
import { DefaultWindowsProjectRuntimeSetting } from './project-runtime/DefaultWindowsProjectRuntimeSetting'
import { defaultScopeHost } from '@/runtime/hosts/selection/default-creation-host'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { GeneralConfirmationsSection } from './GeneralConfirmationsSection'
import { GeneralSearchResults } from './GeneralSearchResults'
import { getGeneralSubPageTitle, type GeneralSubPage } from './general-sub-pages'
import { useOpenInMenuDraft } from './OpenInMenuSetting'

export function getDesktopPlatformFromUserAgent(userAgent: string): 'darwin' | 'win32' | 'other' {
  if (userAgent.includes('Mac')) {
    return 'darwin'
  }
  if (userAgent.includes('Windows')) {
    return 'win32'
  }
  return 'other'
}

export function shouldShowProjectRuntimeSection(
  wslSupportedPlatform: boolean | undefined,
  searchQuery: string,
  entries: SettingsSearchEntry[]
): boolean {
  return Boolean(wslSupportedPlatform) && matchesSettingsSearch(searchQuery, entries)
}

export function getTabOrderControlSearchKeywords(
  entries = getGeneralNavigationSearchEntries(),
  index = 0
): string[] {
  const entry = entries[index]
  return entry ? [entry.title, entry.description ?? '', ...(entry.keywords ?? [])] : []
}

const EMPTY_WSL_DISTROS: string[] = []

type GeneralPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  updateSettingsOrThrow?: (updates: Partial<GlobalSettings>) => void | Promise<void>
  fontSuggestions: string[]
  onRequestFontSuggestions?: () => void
  wslSupportedPlatform?: boolean
  wslAvailable?: boolean
  wslDistros?: string[]
  wslCapabilitiesLoading?: boolean
  subPage?: GeneralSubPage | null
  onSelectSubPage: (page: GeneralSubPage, sectionId?: string) => void
}

export function GeneralPane(props: GeneralPaneProps): React.JSX.Element {
  const query = useAppStore((state) => state.settingsSearchQuery)
  const refreshRemoteUpdates = useAppStore((state) => state.refreshRemoteServerUpdates)
  const remoteUpdatesRequested = useRef(false)
  const showAbout =
    !props.subPage &&
    matchesSettingsSearch(query, [
      ...getGeneralUpdateSearchEntries(),
      ...getGeneralSupportSearchEntries()
    ])
  useEffect(() => {
    if (showAbout && !remoteUpdatesRequested.current) {
      remoteUpdatesRequested.current = true
      void refreshRemoteUpdates()
    }
  }, [showAbout, refreshRemoteUpdates])
  return <GeneralPaneView key={props.subPage ?? 'root'} {...props} query={query} />
}

function GeneralPaneView({
  subPage = null,
  query,
  ...props
}: GeneralPaneProps & { query: string }): React.JSX.Element {
  const t = useTranslate()
  // This owner survives search presentation changes, but ends when its selected page is left.
  const openInDraft = useOpenInMenuDraft(props.settings.openInApplications)
  const sourceRuntimeId = useAppStore(
    (state) => state.worktreeVisibilitySourceDefaultsSupportedRuntimeEnvironmentId
  )
  const defaultsRuntimeId = useAppStore(
    (state) => state.worktreeVisibilityDefaultsSupportedRuntimeEnvironmentId
  )
  const target = defaultScopeHost(props.settings)
  const defaultsSupported = target.kind === 'local' || target.environmentId === defaultsRuntimeId
  const sourceDefaultsSupported =
    defaultsSupported && (target.kind === 'local' || target.environmentId === sourceRuntimeId)
  if (query.trim() === '' && subPage) {
    return subPage === 'editor' ? (
      <GeneralEditorSettingsSection {...props} />
    ) : (
      <GeneralWorkspaceSettingsSection
        {...props}
        page={subPage}
        openInDraft={openInDraft}
        defaultsSupported={defaultsSupported}
        sourceDefaultsSupported={sourceDefaultsSupported}
      />
    )
  }
  const showNavigation = matchesSettingsSearch(query, {
    title: t('auto.components.settings.Settings.7807c11c4d', 'General')
  })
  return (
    <div className="space-y-6">
      <GeneralRootSettings {...props} query={query} showNavigation={showNavigation} />
      {query.trim() && !showNavigation ? (
        <GeneralSearchResults query={query} onSelect={props.onSelectSubPage} />
      ) : null}
    </div>
  )
}

function GeneralRootSettings({
  query,
  showNavigation,
  settings,
  updateSettings,
  onSelectSubPage,
  wslSupportedPlatform,
  wslAvailable,
  wslCapabilitiesLoading,
  wslDistros = EMPTY_WSL_DISTROS
}: GeneralPaneProps & { query: string; showNavigation: boolean }): React.JSX.Element {
  const t = useTranslate()
  const tabsEntries = getGeneralNavigationSearchEntries()
  const runtimeEntries = getGeneralProjectRuntimeSearchEntries()
  const showRuntime = shouldShowProjectRuntimeSection(wslSupportedPlatform, query, runtimeEntries)
  const autoSaveEntries = getGeneralEditorSearchDescriptors()
    .filter((descriptor) => descriptor.page === null)
    .map(({ entry }) => entry)
  const aboutMatches = matchesSettingsSearch(query, [
    ...getGeneralUpdateSearchEntries(),
    ...getGeneralSupportSearchEntries()
  ])
  const worktreeDefaults = settings.worktreeVisibilityDefaults
  const visibilitySummary =
    Object.keys(worktreeDefaults?.sourcePreferences?.builtIn ?? {}).length ||
    Object.keys(worktreeDefaults?.sourcePreferences?.custom ?? {}).length ||
    worktreeDefaults?.customSources?.length
      ? t('settings.general.worktrees.customRules', 'Custom rules')
      : worktreeDefaults?.external === 'show'
        ? t('settings.general.worktrees.shown', 'Shown by default')
        : t('settings.general.worktrees.hidden', 'All hidden')
  return (
    <>
      {matchesSettingsSearch(query, tabsEntries) ? (
        <SettingsGroup title={t('settings.general.tabs.title', 'Tabs')}>
          <TabBarOrderControl
            value={settings.tabBarOrderMode ?? 'manual'}
            keywords={getTabOrderControlSearchKeywords(tabsEntries, 1)}
            updateSettings={updateSettings}
          />
          <RecentTabOrderControl
            ctrlTabOrderMode={settings.ctrlTabOrderMode ?? 'mru'}
            keywords={getTabOrderControlSearchKeywords(tabsEntries)}
            updateSettings={updateSettings}
          />
          <SearchableSetting
            title={t('settings.general.previewTabs.title', 'Preview tabs')}
            description={t(
              'settings.general.previewTabs.description',
              'Single-clicking a file reuses one preview tab until you edit or pin it.'
            )}
            keywords={[
              'preview',
              'tab',
              'editor',
              'explorer',
              'reuse',
              'replace',
              'italic',
              t(
                'auto.components.settings.GeneralPane.editor_preview_tabs',
                'Reuse a preview tab when browsing files'
              )
            ]}
          >
            <SettingsSwitchRow
              label={t('settings.general.previewTabs.title', 'Preview tabs')}
              description={t(
                'settings.general.previewTabs.description',
                'Single-clicking a file reuses one preview tab until you edit or pin it.'
              )}
              checked={settings.editorPreviewTabsEnabled ?? true}
              onChange={() =>
                updateSettings({
                  editorPreviewTabsEnabled: !(settings.editorPreviewTabsEnabled ?? true)
                })
              }
            />
          </SearchableSetting>
        </SettingsGroup>
      ) : null}
      {showNavigation || showRuntime ? (
        <SettingsGroup title={t('settings.general.workspaces.title', 'Workspaces')}>
          {showNavigation ? (
            <>
              <SettingsNavigationRow
                title={getGeneralSubPageTitle('folder', t)}
                description={settings.workspaceDir}
                value={
                  settings.nestWorkspaces
                    ? t('settings.general.folder.perProject', 'Folder per project')
                    : t('settings.general.folder.oneFolder', 'One folder')
                }
                onClick={() => onSelectSubPage('folder')}
              />
              <SettingsNavigationRow
                title={getGeneralSubPageTitle('worktrees', t)}
                description={t(
                  'settings.general.worktrees.description',
                  'Claude Code, GSD and other locations'
                )}
                value={visibilitySummary}
                onClick={() => onSelectSubPage('worktrees')}
              />
              <SettingsNavigationRow
                title={getGeneralSubPageTitle('open-in', t)}
                description={t(
                  'settings.general.openIn.description',
                  'Apps in a workspace’s Open in menu'
                )}
                value={
                  settings.openInApplications?.map((application) => application.label).join(', ') ||
                  t('settings.general.openIn.none', 'No apps added')
                }
                onClick={() => onSelectSubPage('open-in')}
              />
            </>
          ) : null}
          {showRuntime ? (
            <DefaultWindowsProjectRuntimeSetting
              settings={settings}
              updateSettings={updateSettings}
              wslSupportedPlatform={Boolean(wslSupportedPlatform)}
              wslAvailable={Boolean(wslAvailable)}
              wslDistros={wslDistros}
              wslCapabilitiesLoading={Boolean(wslCapabilitiesLoading)}
            />
          ) : null}
        </SettingsGroup>
      ) : null}
      <GeneralConfirmationsSection settings={settings} updateSettings={updateSettings} />
      {showNavigation || matchesSettingsSearch(query, autoSaveEntries) ? (
        <SettingsGroup
          title={t('auto.components.settings.GeneralEditorSettingsSection.45c6e85c4d', 'Editor')}
        >
          <GeneralAutoSaveSetting settings={settings} updateSettings={updateSettings} />
          {showNavigation ? (
            <SettingsNavigationRow
              title={getGeneralSubPageTitle('editor', t)}
              description={t(
                'settings.general.editor.description',
                'Saving, editor, diff and Markdown options'
              )}
              value={
                settings.diffDefaultView === 'side-by-side'
                  ? t('settings.general.editor.sideBySide', 'Side-by-side diffs')
                  : t('settings.general.editor.inline', 'Inline diffs')
              }
              onClick={() => onSelectSubPage('editor')}
            />
          ) : null}
        </SettingsGroup>
      ) : null}
      {matchesSettingsSearch(query, getGeneralCliSearchEntries()) ? (
        <CliSection
          currentPlatform={getDesktopPlatformFromUserAgent(navigator.userAgent)}
          settings={settings}
          wslSupportedPlatform={wslSupportedPlatform}
          wslAvailable={wslAvailable}
          wslCapabilitiesLoading={wslCapabilitiesLoading}
        />
      ) : null}
      {aboutMatches ? (
        <GeneralUpdateSettingsSection>
          <GeneralSupportSection hasPrecedingSections={false} inline />
        </GeneralUpdateSettingsSection>
      ) : null}
    </>
  )
}
