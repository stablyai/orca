import { useState } from 'react'
import type { OrcaHooks, Repo, RepoHookSettings } from '../../../../shared/types'
import { getRepoKindLabel, isFolderRepo } from '../../../../shared/repo-kind'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'
import { Trash2 } from 'lucide-react'
import { BaseRefPicker } from './BaseRefPicker'
import { RepositoryHooksSection } from './RepositoryHooksSection'
import { McpConfigSection } from './McpConfigSection'
import { WorktreeSymlinksSection } from './WorktreeSymlinksSection'
import { SparsePresetSettingsSection } from './SparsePresetSettingsSection'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'
import { useAppStore } from '../../store'
import { getRepositoryIconSectionId } from './repository-settings-targets'
import { RepositoryIconPicker } from './RepositoryIconPicker'
import { getRepositoryPaneSearchEntries } from './repository-search'
export { getRepositoryPaneSearchEntries }

type RepositoryPaneProps = {
  repo: Repo
  yamlHooks: OrcaHooks | null
  hasHooksFile: boolean
  hooksInspectionReady: boolean
  mayNeedUpdate: boolean
  updateRepo: (repoId: string, updates: Partial<Repo>) => void
  removeRepo: (repoId: string) => void
}

export function RepositoryPane({
  repo,
  yamlHooks,
  hasHooksFile,
  hooksInspectionReady,
  mayNeedUpdate,
  updateRepo,
  removeRepo
}: RepositoryPaneProps): React.JSX.Element {
  const isFolder = isFolderRepo(repo)
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const symlinksEnabled = useAppStore((state) => state.settings?.experimentalWorktreeSymlinks)
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null)
  const [copiedTemplate, setCopiedTemplate] = useState(false)

  const handleRemoveRepo = (repoId: string) => {
    if (confirmingRemove === repoId) {
      removeRepo(repoId)
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
    setCopiedTemplate(true)
    window.setTimeout(() => setCopiedTemplate(false), 1500)
  }

  const allEntries = getRepositoryPaneSearchEntries(repo)
  const identityEntries = allEntries.filter((entry) =>
    ['Display Name', 'Project Icon', 'Default Worktree Base', 'Remove Project'].includes(
      entry.title
    )
  )
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

  const hooksSection =
    !isFolder && matchesSettingsSearch(searchQuery, hooksEntries) ? (
      <RepositoryHooksSection
        key="hooks"
        repo={repo}
        yamlHooks={yamlHooks}
        hasHooksFile={hasHooksFile}
        hooksInspectionReady={hooksInspectionReady}
        mayNeedUpdate={mayNeedUpdate}
        copiedTemplate={copiedTemplate}
        onCopyTemplate={() => void handleCopyTemplate()}
        onUpdateHookSettings={updateSelectedRepoHookSettings}
      />
    ) : null

  // Why: Identity (name, icon, base ref) stays at the top so it's the first
  // thing a user sees. Setup commands follow immediately because they're the
  // most-edited surface and should beat MCP/symlinks/sparse-presets.
  const visibleSections = [
    matchesSettingsSearch(searchQuery, identityEntries) ? (
      <section key="identity" className="space-y-8">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">Identity</h3>
            <p className="text-xs text-muted-foreground">
              Project-specific display details for the sidebar and tabs.
            </p>
            <p className="text-xs text-muted-foreground">
              Type: <span className="text-foreground">{getRepoKindLabel(repo)}</span>
            </p>
            {isFolder ? (
              <p className="text-xs text-muted-foreground">
                Opened as folder. Git features are unavailable for this workspace.
              </p>
            ) : null}
          </div>
          <SearchableSetting
            title="Remove Project"
            description="Remove this project from Orca."
            keywords={[repo.displayName, 'delete', 'project', 'repository']}
          >
            <Button
              variant={confirmingRemove === repo.id ? 'destructive' : 'outline'}
              size="sm"
              onClick={() => handleRemoveRepo(repo.id)}
              onBlur={() => setConfirmingRemove(null)}
              className="gap-2"
            >
              <Trash2 className="size-3.5" />
              {confirmingRemove === repo.id ? 'Confirm Remove' : 'Remove Project'}
            </Button>
          </SearchableSetting>
        </div>

        <SearchableSetting
          title="Display Name"
          description="Project-specific display details for the sidebar and tabs."
          keywords={[repo.displayName, repo.path, 'project name', 'repository name']}
          className="space-y-2"
        >
          <Label className="text-sm font-semibold">Display Name</Label>
          <Input
            value={repo.displayName}
            onChange={(e) =>
              updateRepo(repo.id, {
                displayName: e.target.value
              })
            }
            className="h-9 text-sm"
          />
        </SearchableSetting>

        <SearchableSetting
          title="Project Icon"
          description="Project icon and color used in the sidebar and tabs."
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
        >
          <RepositoryIconPicker repo={repo} updateRepo={updateRepo} />
        </SearchableSetting>

        {!isFolder ? (
          <SearchableSetting
            title="Default Worktree Base"
            description="Default base branch or ref when creating worktrees."
            keywords={[repo.displayName, 'base ref', 'branch']}
            className="space-y-3"
          >
            <Label className="text-sm font-semibold">Default Worktree Base</Label>
            <BaseRefPicker
              repoId={repo.id}
              currentBaseRef={repo.worktreeBaseRef}
              onSelect={(ref) => updateRepo(repo.id, { worktreeBaseRef: ref })}
              onUsePrimary={() => updateRepo(repo.id, { worktreeBaseRef: undefined })}
            />
          </SearchableSetting>
        ) : null}
      </section>
    ) : null,
    hooksSection,
    !isFolder &&
    !repo.connectionId &&
    symlinksEnabled &&
    matchesSettingsSearch(searchQuery, symlinkEntries) ? (
      <WorktreeSymlinksSection key="symlinks" repo={repo} updateRepo={updateRepo} />
    ) : null,
    !isFolder && matchesSettingsSearch(searchQuery, sparsePresetEntries) ? (
      <SparsePresetSettingsSection key="sparse-presets" repoId={repo.id} />
    ) : null,
    !isFolder && matchesSettingsSearch(searchQuery, mcpEntries) ? (
      <McpConfigSection key="mcp-configs" repo={repo} />
    ) : null
  ].filter(Boolean)

  return (
    <div className="space-y-8">
      {visibleSections.map((section, index) => (
        <div key={index} className="space-y-8">
          {index > 0 ? <Separator /> : null}
          {section}
        </div>
      ))}
    </div>
  )
}
