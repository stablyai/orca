import { useCallback, useRef, useState } from 'react'
import type {
  OrcaHooks,
  Project,
  ProjectUpdateArgs,
  Repo,
  RepoHookSettings
} from '../../../../shared/types'
import { getRepoKindLabel, isFolderRepo } from '../../../../shared/repo-kind'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'
import { Trash2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { RepositoryHooksSection } from './RepositoryHooksSection'
import { McpConfigSection } from './McpConfigSection'
import { WorktreeSymlinksSection } from './WorktreeSymlinksSection'
import { SparsePresetSettingsSection } from './SparsePresetSettingsSection'
import { RepositorySourceControlAiSection } from './RepositorySourceControlAiSection'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'
import { useAppStore } from '../../store'
import { getRepositoryIconSectionId } from './repository-settings-targets'
import { RepositoryIconPicker } from './RepositoryIconPicker'
import { getRepositoryPaneSearchEntries } from './repository-search'
import { RepositoryHostSetupsSection } from './RepositoryHostSetupsSection'
import { RepoSettingsDraftInput } from './RepositorySettingsDraftInput'
import { RepositoryForkSyncSection } from './RepositoryForkSyncSection'
import { translate } from '@/i18n/i18n'
import { RepositoryWindowsRuntimeSection } from './RepositoryWindowsRuntimeSection'
import { matchesRepositoryIdentitySearch } from './repository-identity-search'
import { RepositoryWorktreeDefaultsSection } from './RepositoryWorktreeDefaultsSection'
import { getProjectRuntimeSessionSummary } from './repository-runtime-session-summary'
export { getRepositoryPaneSearchEntries }
export { matchesRepositoryIdentitySearch } from './repository-identity-search'

type RepositoryPaneRepoUpdate = Omit<Partial<Repo>, 'sourceControlAi'> & {
  sourceControlAi?: Repo['sourceControlAi'] | null
}

const EMPTY_WSL_DISTROS: string[] = []

type RepositoryPaneProps = {
  repo: Repo
  yamlHooks: OrcaHooks | null
  hasHooksFile: boolean
  hooksInspectionReady: boolean
  mayNeedUpdate: boolean
  updateRepo: (repoId: string, updates: RepositoryPaneRepoUpdate) => void
  removeProject: (repoId: string) => void
  project?: Project | null
  isLocalWindowsProject?: boolean
  wslAvailable?: boolean
  wslDistros?: string[]
  wslCapabilitiesLoading?: boolean
  updateProject?: (
    projectId: string,
    updates: ProjectUpdateArgs['updates']
  ) => void | Promise<unknown>
}

export function RepositoryPane({
  repo,
  yamlHooks,
  hasHooksFile,
  hooksInspectionReady,
  mayNeedUpdate,
  updateRepo,
  removeProject,
  project = null,
  isLocalWindowsProject = false,
  wslAvailable = false,
  wslDistros = EMPTY_WSL_DISTROS,
  wslCapabilitiesLoading = false,
  updateProject
}: RepositoryPaneProps): React.JSX.Element {
  const isFolder = isFolderRepo(repo)
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const settings = useAppStore((state) => state.settings)
  const runtimeSessionSummary = useAppStore(
    useShallow((state) => getProjectRuntimeSessionSummary(state, repo.id))
  )
  const symlinksEnabled = settings?.experimentalWorktreeSymlinks
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null)
  const [copiedTemplate, setCopiedTemplate] = useState(false)
  const copiedTemplateResetTimerRef = useRef<number | null>(null)
  // Why: clipboard IPC can resolve after settings navigation; avoid starting
  // a reset timer that will outlive this pane.
  const isMountedRef = useRef(false)
  // Why: searching a project name is navigation to that project, not a
  // request to hide every child row that does not repeat the project name.
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

  const handleRemoveProject = (repoId: string) => {
    if (confirmingRemove === repoId) {
      removeProject(repoId)
      setConfirmingRemove(null)
      return
    }

    setConfirmingRemove(repoId)
  }

  const updateSelectedRepoHookSettings = (nextSettings: RepoHookSettings) => {
    updateRepo(repo.id, {
      hookSettings: nextSettings
    })
  }

  const handleCopyTemplate = async () => {
    // Why: the missing-`orca.yaml` state is a migration aid, so copying the shared-template
    // snippet should be one click rather than forcing users to reconstruct the expected shape.
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
    translate('auto.components.settings.repository.search.7e1e456a95', 'Display Name'),
    translate('auto.components.settings.repository.search.b24f00294a', 'Project Icon'),
    translate(
      'auto.components.settings.repository.search.keepForkUpToDate',
      'Keep Fork Up to Date'
    ),
    translate('auto.components.settings.repository.search.094adbe930', 'Default Worktree Base'),
    translate('auto.components.settings.repository.search.443d127b5a', 'Worktree Location'),
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
  const symlinkEntries = allEntries.filter((entry) => entry.title === 'Worktree Symlinks')
  const sourceControlAiEntries = allEntries.filter((entry) => entry.title === 'Git AI Author')
  const hostSetupEntries = allEntries.filter((entry) => entry.title === 'Available Hosts')
  const projectRuntimeEntries = allEntries.filter((entry) => entry.title === 'Project Runtime')
  const removeProjectLabel =
    confirmingRemove === repo.id ? 'Confirm Remove Project' : 'Remove Project'

  const hooksSection =
    !isFolder && (forceFullPaneForRepoMatch || matchesSettingsSearch(searchQuery, hooksEntries)) ? (
      <RepositoryHooksSection
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

  // Why: Identity (name, icon, base ref) stays at the top so it's the first
  // thing a user sees. Setup commands follow immediately because they're the
  // most-edited surface and should beat MCP/symlinks/sparse-presets.
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
              {translate('auto.components.settings.RepositoryPane.323debba71', 'Type:')}
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
          </div>
          <SearchableSetting
            title={translate(
              'auto.components.settings.RepositoryPane.0909e5d650',
              'Remove Project'
            )}
            description={translate(
              'auto.components.settings.RepositoryPane.170624bdfb',
              'Remove this project from Orca.'
            )}
            keywords={[repo.displayName, 'delete', 'project', 'repository']}
            className="absolute top-0 right-0 z-10 w-auto max-w-none"
            forceVisible={forceFullPaneForRepoMatch}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant={confirmingRemove === repo.id ? 'destructive' : 'outline'}
                  size="icon-sm"
                  onClick={() => handleRemoveProject(repo.id)}
                  onBlur={() => setConfirmingRemove(null)}
                  aria-label={removeProjectLabel}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {removeProjectLabel}
              </TooltipContent>
            </Tooltip>
          </SearchableSetting>
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
            id={`repo-display-name-${repo.id}`}
            repoId={repo.id}
            storeValue={repo.displayName}
            onTextChange={(text) => updateRepo(repo.id, { displayName: text })}
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
          <RepositoryIconPicker repo={repo} updateRepo={updateRepo} />
        </SearchableSetting>

        {!isFolder ? (
          <>
            <RepositoryHostSetupsSection
              repo={repo}
              forceVisible={forceFullPaneForRepoMatch}
              searchQuery={searchQuery}
              searchEntries={hostSetupEntries}
            />

            <RepositoryWindowsRuntimeSection
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
              updateRepo={updateRepo}
              forceVisible={forceFullPaneForRepoMatch}
            />

            <RepositoryWorktreeDefaultsSection
              repo={repo}
              settings={settings}
              updateRepo={updateRepo}
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
        key="source-control-ai"
        repo={repo}
        updateRepo={updateRepo}
      />
    ) : null,
    !isFolder &&
    !repo.connectionId &&
    symlinksEnabled &&
    (forceFullPaneForRepoMatch || matchesSettingsSearch(searchQuery, symlinkEntries)) ? (
      <WorktreeSymlinksSection key="symlinks" repo={repo} updateRepo={updateRepo} />
    ) : null,
    !isFolder &&
    (forceFullPaneForRepoMatch || matchesSettingsSearch(searchQuery, sparsePresetEntries)) ? (
      <SparsePresetSettingsSection key="sparse-presets" repoId={repo.id} />
    ) : null,
    !isFolder && (forceFullPaneForRepoMatch || matchesSettingsSearch(searchQuery, mcpEntries)) ? (
      <McpConfigSection key="mcp-configs" repo={repo} />
    ) : null
  ].filter(Boolean)

  return (
    <div ref={setRepositoryPaneRootRef} className="space-y-8">
      {visibleSections.map((section, index) => (
        <div key={index} className="space-y-8">
          {index > 0 ? <Separator /> : null}
          {section}
        </div>
      ))}
    </div>
  )
}
