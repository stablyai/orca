import {
  RepositoryFormatterSection,
  getRepositoryFormatterSearchEntry
} from './RepositoryFormatterSection'
import type { RepositoryPaneProps } from './repository-pane-types'
import type { RepositorySettingsSessionState } from './RepositorySettingsSession'
import type { RepoHookSettings } from '../../../../../shared/orca-yaml-hook-types'
import { useFolderSetupSupport } from '@/lib/use-folder-setup-supported'
import { ProjectGroupingSetting } from '../ProjectGroupingSetting'
import { useCallback, useRef, useState } from 'react'
import { getRepoKindLabel, isFolderRepo } from '../../../../../shared/repo-kind'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host'
import { Label } from '../../ui/label'
import { useShallow } from 'zustand/react/shallow'
import { RepositoryHooksSection } from './hooks/RepositoryHooksSection'
import { McpConfigSection } from './mcp/McpConfigSection'
import { WorktreeSymlinksSection } from './worktrees/WorktreeSymlinksSection'
import { SparsePresetSettingsSection } from './worktrees/SparsePresetSettingsSection'
import { RepositorySourceControlAiSection } from './source-control/RepositorySourceControlAiSection'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import {
  useSettingsProjectRemovalDescription,
  prepareSettingsProjectRemoval,
  RepositoryRemoveProjectButton
} from './RepositoryRemoveProjectButton'
import { matchesSettingsSearch } from '../search/settings-search'
import { useAppStore } from '@/store/index'
import { getRepositoryIconSectionId } from './repository-settings-targets'
import { RepositoryIconPicker } from './identity/RepositoryIconPicker'
import { getRepositoryPaneSearchMetadata } from './repository-search-metadata'
import { RepositoryHostSetupsSection } from './hosts/RepositoryHostSetupsSection'
import { RepoSettingsDraftInput } from './RepositorySettingsDraftInput'
import { RepositoryForkSyncSection } from './source-control/RepositoryForkSyncSection'
import { RepositoryAgentTrustSection } from './RepositoryAgentTrustSection'
import { RepositoryGitHubAccountSection } from './source-control/RepositoryGitHubAccountSection'
import { useTranslate } from '@/i18n/use-translate'
import { RepositoryWindowsRuntimeSection } from './runtime/RepositoryWindowsRuntimeSection'
import { matchesRepositoryIdentitySearch } from './identity/repository-identity-search'
import { RepositoryWorktreeDefaultsSection } from './worktrees/RepositoryWorktreeDefaultsSection'
import { RepositoryJiraProjectSection } from './RepositoryJiraProjectSection'
import { getProjectRuntimeSessionSummary } from './runtime/repository-runtime-session-summary'
import { getRepoOwnerWorktreeVisibilityDefaults } from '../../../store/slices/worktrees/listing/worktree-visibility-defaults-by-host'

const EMPTY_WSL_DISTROS: string[] = []

export function RepositoryPaneView({
  session,
  repo,
  yamlHooks,
  hasHooksFile,
  hooksInspectionReady,
  mayNeedUpdate,
  removeProject,
  project = null,
  selectedProjectSetupId,
  settingsSelectionKey,
  settingsEntryRepoIds,
  removalScope = 'project',
  removalSetups,
  isLocalWindowsProject = false,
  wslAvailable = false,
  wslDistros = EMPTY_WSL_DISTROS,
  wslCapabilitiesLoading = false,
  updateProject,
  writeSourceControlAiSettings
}: RepositoryPaneProps & { session: RepositorySettingsSessionState }): React.JSX.Element {
  const t = useTranslate()
  const removal = useSettingsProjectRemovalDescription(
    repo,
    removalScope,
    settingsSelectionKey,
    removalSetups
  )
  const readCurrentRemoval = () =>
    prepareSettingsProjectRemoval(
      useAppStore.getState(),
      repo,
      removalScope,
      settingsSelectionKey,
      removalSetups
    )
  const isFolder = isFolderRepo(repo)
  const hooksSupported = useFolderSetupSupport(repo) === 'supported'
  // Bind writes to the switcher-selected owner; same-ID/self-paired repos must not use focused-host fallback.
  const selectedHostId = getRepoExecutionHostId(repo)
  const { updateSelectedRepo } = session
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const settings = useAppStore((state) => state.settings)
  const worktreeVisibilityDefaultsByHost = useAppStore(
    (state) => state.worktreeVisibilityDefaultsByHost
  )
  const repoOwnerSettings = settings
    ? {
        ...settings,
        worktreeVisibilityDefaults: getRepoOwnerWorktreeVisibilityDefaults(
          repo,
          settings,
          worktreeVisibilityDefaultsByHost
        )
      }
    : null
  const fetchWorktrees = useAppStore((state) => state.fetchWorktrees)
  const runtimeSessionSummary = useAppStore(
    useShallow((state) => getProjectRuntimeSessionSummary(state, repo.id))
  )
  const [copiedTemplate, setCopiedTemplate] = useState(false)
  const copiedTemplateResetTimerRef = useRef<number | null>(null)
  // Clipboard IPC may outlive navigation; do not start timers after pane detach.
  const isMountedRef = useRef(false)
  // Project-name search navigates to the project; it must not hide child controls that omit the name.
  const forceFullPaneForRepoMatch = matchesRepositoryIdentitySearch(searchQuery, repo)

  const clearCopiedTemplateResetTimer = useCallback((): void => {
    if (copiedTemplateResetTimerRef.current !== null) {
      window.clearTimeout(copiedTemplateResetTimerRef.current)
      copiedTemplateResetTimerRef.current = null
    }
  }, [])

  const setRepositoryPaneRootRef = useCallback(
    (node: HTMLDivElement | null) => {
      isMountedRef.current = node !== null
      if (node === null) {
        clearCopiedTemplateResetTimer()
      }
    },
    [clearCopiedTemplateResetTimer]
  )

  const updateSelectedRepoHookSettings = (nextSettings: RepoHookSettings) => {
    updateSelectedRepo(repo.id, {
      hookSettings: nextSettings
    })
  }

  const handleCopyTemplate = async () => {
    // Make missing-orca.yaml migration a one-click copy of the expected shared-template shape.
    await window.api.ui.writeClipboardText(`scripts:
  setup: |
    pnpm worktree:setup
  archive: |
    echo "Cleaning up before archive"`)
    if (!isMountedRef.current) {
      return
    }
    clearCopiedTemplateResetTimer()
    setCopiedTemplate(true)
    copiedTemplateResetTimerRef.current = window.setTimeout(() => {
      copiedTemplateResetTimerRef.current = null
      setCopiedTemplate(false)
    }, 1500)
  }

  const {
    identity: identityEntries,
    sparsePresets: sparsePresetEntries,
    hooks: hooksEntries,
    mcp: mcpEntries,
    sharedPaths: symlinkEntries,
    sourceControlAi: sourceControlAiEntries,
    hostSetups: hostSetupEntries,
    projectRuntime: projectRuntimeEntries
  } = getRepositoryPaneSearchMetadata(repo, { isLocalWindowsProject }, t)

  const hooksSection =
    hooksSupported &&
    (forceFullPaneForRepoMatch || matchesSettingsSearch(searchQuery, hooksEntries)) ? (
      <RepositoryHooksSection
        controller={session.hooks}
        key="hooks"
        repo={repo}
        yamlHooks={yamlHooks}
        hasHooksFile={hasHooksFile}
        hooksInspectionReady={hooksInspectionReady}
        mayNeedUpdate={mayNeedUpdate}
        copiedTemplate={copiedTemplate}
        forceVisible={forceFullPaneForRepoMatch}
        onCopyTemplate={() => void handleCopyTemplate()}
        onUpdateHookSettings={updateSelectedRepoHookSettings}
      />
    ) : null

  // Lead with identity, then frequently edited setup commands, before secondary repository controls.
  const visibleSections = [
    forceFullPaneForRepoMatch || matchesSettingsSearch(searchQuery, identityEntries) ? (
      <SettingsGroup
        key="identity"
        title={t('auto.components.settings.RepositoryPane.499a437335', 'Identity')}
        description={
          <>
            {t(
              'auto.components.settings.RepositoryPane.b0a0c14a1c',
              'Project-specific display details for the sidebar and tabs.'
            )}
            <span className="block">
              {t('auto.components.settings.RepositoryPane.323debba71', 'Type:')}{' '}
              <span className="text-foreground">{getRepoKindLabel(repo)}</span>
            </span>
            {isFolder ? (
              <span className="block">
                {t(
                  'auto.components.settings.RepositoryPane.ee5a290616',
                  'Opened as folder. Git features are unavailable for this workspace.'
                )}
              </span>
            ) : null}
            <span className="block">{removal.description}</span>
          </>
        }
        action={
          <RepositoryRemoveProjectButton
            repo={repo}
            description={removal.description}
            confirmationKey={removal.signature}
            forceVisible={forceFullPaneForRepoMatch}
            readCurrentRemoval={readCurrentRemoval}
            removeProject={removeProject}
          />
        }
      >
        <SearchableSetting
          title={t('auto.components.settings.RepositoryPane.07deadaa00', 'Display name')}
          description={t(
            'auto.components.settings.RepositoryPane.b0a0c14a1c',
            'Project-specific display details for the sidebar and tabs.'
          )}
          keywords={[repo.displayName, repo.path, 'project name', 'repository name']}
          className="space-y-2 py-3"
          forceVisible={forceFullPaneForRepoMatch}
        >
          <Label htmlFor={`repo-display-name-${repo.id}`} className="text-sm font-semibold">
            {t('auto.components.settings.RepositoryPane.07deadaa00', 'Display name')}
          </Label>
          <RepoSettingsDraftInput
            controller={session.name}
            id={`repo-display-name-${repo.id}`}
            repoId={repo.id}
            storeValue={repo.displayName}
            onTextChange={(text) => updateSelectedRepo(repo.id, { displayName: text })}
            className="h-9 text-sm"
          />
        </SearchableSetting>

        <SearchableSetting
          title={t('auto.components.settings.RepositoryPane.e856e61455', 'Project icon')}
          description={t(
            'auto.components.settings.RepositoryPane.e641c359de',
            'Project icon and color used in the sidebar and tabs.'
          )}
          keywords={[
            repo.displayName,
            repo.path,
            'project icon',
            'repository icon',
            'color',
            'badge',
            'emoji',
            'favicon'
          ]}
          className="space-y-2 py-3"
          id={getRepositoryIconSectionId(repo.id)}
          forceVisible={forceFullPaneForRepoMatch}
        >
          <RepositoryIconPicker
            websiteInput={session.websiteInput}
            repo={repo}
            updateRepo={updateSelectedRepo}
          />
        </SearchableSetting>

        <RepositoryJiraProjectSection
          key={`${selectedHostId}:${repo.id}`}
          repo={repo}
          updateRepo={updateSelectedRepo}
          forceVisible={forceFullPaneForRepoMatch}
        />

        <RepositoryAgentTrustSection
          repo={repo}
          updateRepo={updateSelectedRepo}
          forceVisible={forceFullPaneForRepoMatch}
        />

        {!isFolder ? (
          <>
            <RepositoryHostSetupsSection
              repo={repo}
              selectedProjectSetupId={selectedProjectSetupId}
              settingsSelectionKey={settingsSelectionKey}
              settingsEntryRepoIds={settingsEntryRepoIds}
              forceVisible={forceFullPaneForRepoMatch}
              searchQuery={searchQuery}
              searchEntries={hostSetupEntries}
            />

            {settings && project ? (
              <ProjectGroupingSetting
                forceVisible={forceFullPaneForRepoMatch}
                settings={settings}
                updateSettings={updateSettings}
                projectId={project.id}
              />
            ) : null}

            <RepositoryWindowsRuntimeSection
              repo={repo}
              repoDisplayName={repo.displayName}
              project={project}
              settings={settings}
              isLocalWindowsProject={isLocalWindowsProject}
              wslAvailable={wslAvailable}
              wslDistros={wslDistros}
              wslCapabilitiesLoading={wslCapabilitiesLoading}
              runtimeSessionSummary={runtimeSessionSummary}
              updateProject={updateProject}
              forceVisible={forceFullPaneForRepoMatch}
              searchQuery={searchQuery}
              searchEntries={projectRuntimeEntries}
            />

            <RepositoryForkSyncSection
              repo={repo}
              updateRepo={updateSelectedRepo}
              forceVisible={forceFullPaneForRepoMatch}
            />

            <RepositoryGitHubAccountSection
              repo={repo}
              updateRepo={updateSelectedRepo}
              forceVisible={forceFullPaneForRepoMatch}
            />

            <RepositoryWorktreeDefaultsSection
              locationInput={session.location}
              repo={repo}
              settings={repoOwnerSettings}
              updateRepo={updateSelectedRepo}
              refreshRepo={(repoId) =>
                fetchWorktrees(repoId, {
                  executionHostId: selectedHostId,
                  requireAuthoritative: true
                })
              }
              forceVisible={forceFullPaneForRepoMatch}
            />
          </>
        ) : null}
      </SettingsGroup>
    ) : null,
    hooksSection,
    forceFullPaneForRepoMatch ||
    matchesSettingsSearch(searchQuery, [getRepositoryFormatterSearchEntry(t)]) ? (
      <RepositoryFormatterSection
        key={`formatter-${repo.id}-${selectedHostId}`}
        repo={repo}
        updateRepo={updateSelectedRepo}
        forceVisible={forceFullPaneForRepoMatch}
      />
    ) : null,
    !isFolder &&
    (forceFullPaneForRepoMatch || matchesSettingsSearch(searchQuery, sourceControlAiEntries)) ? (
      <RepositorySourceControlAiSection
        controller={session.ai}
        writeSourceControlAiSettings={writeSourceControlAiSettings}
        key="source-control-ai"
        repo={repo}
        updateRepo={updateSelectedRepo}
      />
    ) : null,
    !isFolder &&
    !repo.connectionId &&
    (forceFullPaneForRepoMatch || matchesSettingsSearch(searchQuery, symlinkEntries)) ? (
      <WorktreeSymlinksSection
        input={session.symlinks}
        key="symlinks"
        repo={repo}
        updateRepo={updateSelectedRepo}
      />
    ) : null,
    !isFolder &&
    (forceFullPaneForRepoMatch || matchesSettingsSearch(searchQuery, sparsePresetEntries)) ? (
      <SparsePresetSettingsSection
        controller={session.sparse}
        currentRepo={repo}
        key={`sparse-presets:${repo.id}`}
        repoId={repo.id}
      />
    ) : null,
    !isFolder && (forceFullPaneForRepoMatch || matchesSettingsSearch(searchQuery, mcpEntries)) ? (
      <McpConfigSection key={`mcp-configs:${selectedHostId}:${repo.id}`} repo={repo} />
    ) : null
  ]

  return (
    <div ref={setRepositoryPaneRootRef} className="space-y-8">
      {visibleSections}
    </div>
  )
}
