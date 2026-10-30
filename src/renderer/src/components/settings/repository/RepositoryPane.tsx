import type { RepoHookSettings } from '../../../../../shared/orca-yaml-hook-types'
import {
  RepositorySettingsSession,
  type RepositorySettingsSessionState
} from './RepositorySettingsSession'
import { getRepoHostIdentity } from '../../../store/slices/repo-host-identity'
import { ProjectGroupingSetting } from '../ProjectGroupingSetting'
import { useCallback, useRef, useState } from 'react'
import { getRepoKindLabel, isFolderRepo } from '../../../../../shared/repo-kind'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host'
import { Label } from '../../ui/label'
import { Separator } from '../../ui/separator'
import { useShallow } from 'zustand/react/shallow'
import { RepositoryHooksSection } from './execution/RepositoryHooksSection'
import { McpConfigSection } from '../McpConfigSection'
import { WorktreeSymlinksSection } from '../WorktreeSymlinksSection'
import { SparsePresetSettingsSection } from '../SparsePresetSettingsSection'
import { RepositorySourceControlAiSection } from './source-control/RepositorySourceControlAiSection'
import { SearchableSetting } from '../SearchableSetting'
import {
  getRemoveProjectDescription,
  RepositoryRemoveProjectButton
} from './RepositoryRemoveProjectButton'
import { matchesSettingsSearch } from '../settings-search'
import { useAppStore } from '@/store/index'
import { getRepositoryIconSectionId } from './repository-settings-targets'
import { RepositoryIconPicker } from './identity/RepositoryIconPicker'
import { getRepositoryPaneSearchEntries, projectGroupingSearchEntry } from './repository-search'
import { RepositoryHostSetupsSection } from './execution/RepositoryHostSetupsSection'
import { RepoSettingsDraftInput } from './RepositorySettingsDraftInput'
import { RepositoryForkSyncSection } from './identity/RepositoryForkSyncSection'
import { RepositoryGitHubAccountSection } from './RepositoryGitHubAccountSection'
import { translate } from '@/i18n/i18n'
import { RepositoryWindowsRuntimeSection } from './execution/RepositoryWindowsRuntimeSection'
import { matchesRepositoryIdentitySearch } from './identity/repository-identity-search'
import { RepositoryWorktreeDefaultsSection } from './execution/RepositoryWorktreeDefaultsSection'
import { RepositoryJiraProjectSection } from './RepositoryJiraProjectSection'
import { getProjectRuntimeSessionSummary } from './execution/repository-runtime-session-summary'
import { getRepoOwnerWorktreeVisibilityDefaults } from '../../../store/worktree-visibility-defaults-by-host'

export type { RepositoryPaneRepoUpdate } from './repository-pane-types'
import type { RepositoryPaneProps } from './repository-pane-types'

const EMPTY_WSL_DISTROS: string[] = []

export function RepositoryPane(props: RepositoryPaneProps): React.JSX.Element {
  return props.session ? (
    <RepositoryPaneView {...props} session={props.session} />
  ) : (
    <RepositorySettingsSession
      key={getRepoHostIdentity(props.repo)}
      repo={props.repo}
      repoId={props.repo.id}
      hostId={getRepoExecutionHostId(props.repo)}
      isFolder={isFolderRepo(props.repo)}
      updateRepo={props.updateRepo}
    >
      {(session) => <RepositoryPaneView {...props} session={session} />}
    </RepositorySettingsSession>
  )
}
function RepositoryPaneView({
  session,
  repo,
  yamlHooks,
  hasHooksFile,
  hooksInspectionReady,
  mayNeedUpdate,
  updateRepo: _updateRepo,
  removeProject,
  project = null,
  selectedProjectSetupId,
  settingsSelectionKey,
  settingsEntryRepoIds,
  removalScope = 'project',
  isLocalWindowsProject = false,
  wslAvailable = false,
  wslDistros = EMPTY_WSL_DISTROS,
  wslCapabilitiesLoading = false,
  updateProject
}: RepositoryPaneProps & { session: RepositorySettingsSessionState }): React.JSX.Element {
  const isFolder = isFolderRepo(repo)
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

  const allEntries = getRepositoryPaneSearchEntries(repo, { isLocalWindowsProject })
  const identityEntryTitles = new Set([
    projectGroupingSearchEntry(repo.displayName).title,
    translate('auto.components.settings.repository.search.7e1e456a95', 'Display Name'),
    translate('auto.components.settings.repository.search.b24f00294a', 'Project Icon'),
    translate('components.RepositoryJiraProjectSection.title', 'Default Jira project'),
    translate('auto.components.settings.repository.search.githubAccount', 'GitHub Account'),
    translate(
      'auto.components.settings.repository.search.keepForkUpToDate',
      'Keep Fork Up to Date'
    ),
    translate('auto.components.settings.repository.search.094adbe930', 'Default Worktree Base'),
    translate('auto.components.settings.repository.search.443d127b5a', 'Worktree Location'),
    translate('auto.components.settings.repository.search.externalWorktrees', 'External worktrees'),
    translate('auto.components.settings.repository.search.projectRuntime', 'Project Runtime'),
    translate('auto.components.settings.repository.search.c5266c2c9d', 'Remove Project')
  ])
  const identityEntries = allEntries.filter((entry) => identityEntryTitles.has(entry.title))
  const sparsePresetEntries = allEntries.filter((entry) =>
    ['Sparse Checkout Presets'].includes(entry.title)
  )
  const hooksEntries = allEntries.filter((entry) =>
    [
      'Setup Script',
      'Archive Script',
      'Advanced',
      'When to Run Setup',
      'Custom GitHub Issue Command'
    ].includes(entry.title)
  )
  const mcpEntries = allEntries.filter((entry) => entry.title === 'MCP Configs')
  const symlinkEntries = allEntries.filter((entry) => entry.title === 'Worktree Shared Paths')
  const sourceControlAiEntries = allEntries.filter((entry) => entry.title === 'Git AI Author')
  const hostSetupEntries = allEntries.filter((entry) => entry.title === 'Available Hosts')
  const projectRuntimeEntries = allEntries.filter((entry) => entry.title === 'Project Runtime')

  const hooksSection =
    !isFolder && (forceFullPaneForRepoMatch || matchesSettingsSearch(searchQuery, hooksEntries)) ? (
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
      <section key="identity" className="relative space-y-8">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1 pr-12">
            <h3 className="text-sm font-semibold">
              {translate('auto.components.settings.RepositoryPane.499a437335', 'Identity')}
            </h3>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.RepositoryPane.b0a0c14a1c',
                'Project-specific display details for the sidebar and tabs.'
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {translate('auto.components.settings.RepositoryPane.323debba71', 'Type:')}{' '}
              <span className="text-foreground">{getRepoKindLabel(repo)}</span>
            </p>
            {isFolder ? (
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.RepositoryPane.ee5a290616',
                  'Opened as folder. Git features are unavailable for this workspace.'
                )}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {getRemoveProjectDescription(removalScope, repo)}
            </p>
          </div>
          <RepositoryRemoveProjectButton
            repo={repo}
            removalScope={removalScope}
            forceVisible={forceFullPaneForRepoMatch}
            removeProject={removeProject}
          />
        </div>

        <SearchableSetting
          title={translate('auto.components.settings.RepositoryPane.c7ef4415de', 'Display Name')}
          description={translate(
            'auto.components.settings.RepositoryPane.b0a0c14a1c',
            'Project-specific display details for the sidebar and tabs.'
          )}
          keywords={[repo.displayName, repo.path, 'project name', 'repository name']}
          className="space-y-2"
          forceVisible={forceFullPaneForRepoMatch}
        >
          <Label htmlFor={`repo-display-name-${repo.id}`} className="text-sm font-semibold">
            {translate('auto.components.settings.RepositoryPane.c7ef4415de', 'Display Name')}
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
          title={translate('auto.components.settings.RepositoryPane.26fef02bf3', 'Project Icon')}
          description={translate(
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
          className="space-y-2"
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
      </section>
    ) : null,
    hooksSection,
    !isFolder &&
    (forceFullPaneForRepoMatch || matchesSettingsSearch(searchQuery, sourceControlAiEntries)) ? (
      <RepositorySourceControlAiSection
        controller={session.ai}
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
  const renderedSections = visibleSections.filter((section) => section !== null)

  return (
    <div ref={setRepositoryPaneRootRef} className="space-y-8">
      {renderedSections.map((section, index) => (
        <div key={section.key} className="space-y-8">
          {index > 0 ? <Separator /> : null}
          {section}
        </div>
      ))}
    </div>
  )
}
