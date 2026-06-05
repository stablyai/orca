import { useCallback, useEffect, useRef, useState } from 'react'
import type { OrcaHooks, Repo, RepoHookSettings } from '../../../../shared/types'
import { getRepoKindLabel, isFolderRepo } from '../../../../shared/repo-kind'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'
import { Trash2 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { BaseRefPicker } from './BaseRefPicker'
import { RepositoryHooksSection } from './RepositoryHooksSection'
import { McpConfigSection } from './McpConfigSection'
import { WorktreeSymlinksSection } from './WorktreeSymlinksSection'
import { SparsePresetSettingsSection } from './SparsePresetSettingsSection'
import { RepositorySourceControlAiSection } from './RepositorySourceControlAiSection'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch, normalizeSettingsSearchQuery } from './settings-search'
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
  removeProject: (repoId: string) => void
}

type RepoTextDraft = { repoId: string; text: string }

// Why: updateRepo persists via async IPC before the store value updates, so a
// store-controlled input resets mid-IME-composition (Hangul decomposes into
// jamo). Keep keystrokes in local draft state; persist stays per-keystroke.
export function RepoSettingsDraftInput({
  repoId,
  storeValue,
  onTextChange,
  ...inputProps
}: {
  repoId: string
  storeValue: string
  onTextChange: (text: string) => void
} & Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange'>): React.JSX.Element {
  const [draft, setDraft] = useState<RepoTextDraft>({ repoId, text: storeValue })
  const pendingStoreEchoesRef = useRef<string[]>([])

  useEffect(() => {
    setDraft((current) => {
      if (current.repoId !== repoId) {
        pendingStoreEchoesRef.current = []
        return { repoId, text: storeValue }
      }
      if (storeValue === current.text) {
        pendingStoreEchoesRef.current = []
        return current
      }
      const pendingEchoIndex = pendingStoreEchoesRef.current.indexOf(storeValue)
      if (pendingEchoIndex !== -1) {
        // Why: queued updateRepo calls can echo older input text after newer
        // keystrokes; accepting that echo re-cancels active IME composition.
        pendingStoreEchoesRef.current.splice(0, pendingEchoIndex + 1)
        return current
      }
      pendingStoreEchoesRef.current = []
      return { repoId, text: storeValue }
    })
  }, [repoId, storeValue])

  const text = draft.repoId === repoId ? draft.text : storeValue
  return (
    <Input
      {...inputProps}
      value={text}
      onChange={(e) => {
        const nextText = e.target.value
        pendingStoreEchoesRef.current.push(nextText)
        setDraft({ repoId, text: nextText })
        onTextChange(nextText)
      }}
    />
  )
}

export function matchesRepositoryIdentitySearch(query: string, repo: Repo): boolean {
  const normalizedQuery = normalizeSettingsSearchQuery(query)
  if (!normalizedQuery) {
    return false
  }
  return [repo.displayName, repo.path].some((value) =>
    value.toLowerCase().includes(normalizedQuery)
  )
}

export function RepositoryPane({
  repo,
  yamlHooks,
  hasHooksFile,
  hooksInspectionReady,
  mayNeedUpdate,
  updateRepo,
  removeProject
}: RepositoryPaneProps): React.JSX.Element {
  const isFolder = isFolderRepo(repo)
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const settings = useAppStore((state) => state.settings)
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

  const allEntries = getRepositoryPaneSearchEntries(repo)
  const identityEntries = allEntries.filter((entry) =>
    [
      'Display Name',
      'Project Icon',
      'Default Worktree Base',
      'Worktree Location',
      'Remove Project'
    ].includes(entry.title)
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
  const sourceControlAiEntries = allEntries.filter((entry) => entry.title === 'Git AI Author')
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
          title="Display Name"
          description="Project-specific display details for the sidebar and tabs."
          keywords={[repo.displayName, repo.path, 'project name', 'repository name']}
          className="space-y-2"
          forceVisible={forceFullPaneForRepoMatch}
        >
          <Label htmlFor={`repo-display-name-${repo.id}`} className="text-sm font-semibold">
            Display Name
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
          forceVisible={forceFullPaneForRepoMatch}
        >
          <RepositoryIconPicker repo={repo} updateRepo={updateRepo} />
        </SearchableSetting>

        {!isFolder ? (
          <>
            <SearchableSetting
              title="Default Worktree Base"
              description="Default base branch or ref when creating worktrees."
              keywords={[repo.displayName, 'base ref', 'branch']}
              className="space-y-3"
              forceVisible={forceFullPaneForRepoMatch}
            >
              <Label className="text-sm font-semibold">Default Worktree Base</Label>
              <BaseRefPicker
                repoId={repo.id}
                currentBaseRef={repo.worktreeBaseRef}
                onSelect={(ref) => updateRepo(repo.id, { worktreeBaseRef: ref })}
                onUsePrimary={() => updateRepo(repo.id, { worktreeBaseRef: undefined })}
              />
            </SearchableSetting>

            <SearchableSetting
              title="Worktree Location"
              description="Project-specific directory for new worktrees."
              keywords={[
                repo.displayName,
                'worktree path',
                'workspace path',
                'directory',
                'relative',
                '../worktrees'
              ]}
              className="space-y-2"
              forceVisible={forceFullPaneForRepoMatch}
            >
              <div className="flex items-center justify-between gap-3">
                <Label className="text-sm font-semibold">Worktree Location</Label>
                {repo.worktreeBasePath ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => updateRepo(repo.id, { worktreeBasePath: undefined })}
                  >
                    Use Global
                  </Button>
                ) : null}
              </div>
              <RepoSettingsDraftInput
                repoId={repo.id}
                storeValue={repo.worktreeBasePath ?? ''}
                placeholder={settings?.workspaceDir ?? ''}
                onTextChange={(text) =>
                  updateRepo(repo.id, { worktreeBasePath: text.trim() ? text : undefined })
                }
                className="h-9 text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Relative paths resolve from this project root.
              </p>
            </SearchableSetting>
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
