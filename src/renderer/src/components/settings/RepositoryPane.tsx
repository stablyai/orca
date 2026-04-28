import { useState } from 'react'
import type { OrcaHooks, Repo, RepoHookSettings, SetupRunPolicy } from '../../../../shared/types'
import { getRepoKindLabel, isFolderRepo } from '../../../../shared/repo-kind'
import { REPO_COLORS } from '../../../../shared/constants'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'
import { Trash2 } from 'lucide-react'
import { DEFAULT_REPO_HOOK_SETTINGS } from './SettingsConstants'
import { BaseRefPicker } from './BaseRefPicker'
import { RepositoryHooksSection } from './RepositoryHooksSection'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch, type SettingsSearchEntry } from './settings-search'
import { useAppStore } from '../../store'

type RepositoryPaneProps = {
  repo: Repo
  yamlHooks: OrcaHooks | null
  hasHooksFile: boolean
  mayNeedUpdate: boolean
  updateRepo: (repoId: string, updates: Partial<Repo>) => void
  removeRepo: (repoId: string) => void
}

export function getRepositoryPaneSearchEntries(repo: Repo): SettingsSearchEntry[] {
  const isFolder = isFolderRepo(repo)
  return [
    {
      title: 'Display Name',
      description: 'Repo-specific display details for the sidebar and tabs.',
      keywords: [repo.displayName, repo.path, 'repository name']
    },
    {
      title: 'Badge Color',
      description: 'Repo color used in the sidebar and tabs.',
      keywords: [repo.displayName, 'color', 'badge']
    },
    ...(isFolder
      ? []
      : [
          {
            title: 'Default Worktree Base',
            description: 'Default base branch or ref when creating worktrees.',
            keywords: [repo.displayName, 'base ref', 'branch']
          }
        ]),
    {
      title: 'Remove Repo',
      description: 'Remove this repository from Orca.',
      keywords: [repo.displayName, 'delete', 'repository']
    },
    ...(isFolder
      ? []
      : [
          {
            title: 'orca.yaml hooks',
            description: 'Shared setup and archive hook commands for this repository.',
            keywords: [repo.displayName, 'hooks', 'setup', 'archive', 'yaml']
          },
          {
            title: 'Legacy Repo-Local Hooks',
            description: 'Older setup and archive hook scripts stored in local repo settings.',
            keywords: [repo.displayName, 'legacy', 'fallback', 'hooks']
          },
          {
            title: 'When to Run Setup',
            description: 'Choose the default behavior when a setup command is available.',
            keywords: [
              repo.displayName,
              'setup run policy',
              'ask',
              'run by default',
              'skip by default'
            ]
          },
          {
            title: 'Custom GitHub Issue Command',
            description:
              'File-based linked-issue command configured via orca.yaml and optional local override.',
            keywords: [
              repo.displayName,
              'github issue command',
              'issue command',
              'workflow',
              'github',
              'orca.yaml',
              '.orca/issue-command'
            ]
          }
        ])
  ]
}

export function RepositoryPane({
  repo,
  yamlHooks,
  hasHooksFile,
  mayNeedUpdate,
  updateRepo,
  removeRepo
}: RepositoryPaneProps): React.JSX.Element {
  const isFolder = isFolderRepo(repo)
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
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

  const updateSelectedRepoHookSettings = (
    updates: Partial<Pick<RepoHookSettings, 'setupRunPolicy'>>
  ) => {
    // Why: persisted repos may still carry legacy UI hook fields from the old dual-source
    // design. We preserve them when saving so existing local state stays loadable, but the
    // product now treats `orca.yaml` as the only supported hook definition surface.
    const nextSettings: RepoHookSettings = {
      ...DEFAULT_REPO_HOOK_SETTINGS,
      ...repo.hookSettings,
      ...updates
    }

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

  const handleClearLegacyHooks = () => {
    // Why: legacy repo-local commands are still honored as a compatibility fallback.
    // Keep them visible and removable here so the settings surface matches runtime behavior.
    updateRepo(repo.id, {
      hookSettings: {
        ...DEFAULT_REPO_HOOK_SETTINGS,
        ...repo.hookSettings,
        scripts: {
          ...DEFAULT_REPO_HOOK_SETTINGS.scripts,
          setup: '',
          archive: ''
        }
      }
    })
  }

  const allEntries = getRepositoryPaneSearchEntries(repo)
  const identityEntries = allEntries.filter((entry) =>
    ['Display Name', 'Badge Color', 'Default Worktree Base', 'Remove Repo'].includes(entry.title)
  )
  const hooksEntries = allEntries.filter((entry) =>
    [
      'orca.yaml hooks',
      'Legacy Repo-Local Hooks',
      'When to Run Setup',
      'Custom GitHub Issue Command'
    ].includes(entry.title)
  )

  const visibleSections = [
    matchesSettingsSearch(searchQuery, identityEntries) ? (
      <section key="identity" className="space-y-8">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">Identity</h3>
            <p className="text-xs text-muted-foreground">
              Repo-specific display details for the sidebar and tabs.
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
            title="Remove Repo"
            description="Remove this repository from Orca."
            keywords={[repo.displayName, 'delete', 'repository']}
          >
            <Button
              variant={confirmingRemove === repo.id ? 'destructive' : 'outline'}
              size="sm"
              onClick={() => handleRemoveRepo(repo.id)}
              onBlur={() => setConfirmingRemove(null)}
              className="gap-2"
            >
              <Trash2 className="size-3.5" />
              {confirmingRemove === repo.id ? 'Confirm Remove' : 'Remove Repo'}
            </Button>
          </SearchableSetting>
        </div>

        <SearchableSetting
          title="Display Name"
          description="Repo-specific display details for the sidebar and tabs."
          keywords={[repo.displayName, repo.path, 'repository name']}
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
          title="Badge Color"
          description="Repo color used in the sidebar and tabs."
          keywords={[repo.displayName, 'color', 'badge']}
          className="space-y-2"
        >
          <Label className="text-sm font-semibold">Badge Color</Label>
          <div className="flex flex-wrap gap-2">
            {REPO_COLORS.map((color) => (
              <button
                key={color}
                onClick={() => updateRepo(repo.id, { badgeColor: color })}
                className={`size-7 rounded-full transition-all ${
                  repo.badgeColor === color
                    ? 'ring-2 ring-foreground ring-offset-2 ring-offset-background'
                    : 'hover:ring-1 hover:ring-muted-foreground hover:ring-offset-2 hover:ring-offset-background'
                }`}
                style={{ backgroundColor: color }}
                title={color}
              />
            ))}
          </div>
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
    !isFolder && matchesSettingsSearch(searchQuery, hooksEntries) ? (
      <RepositoryHooksSection
        key="hooks"
        repo={repo}
        yamlHooks={yamlHooks}
        hasHooksFile={hasHooksFile}
        mayNeedUpdate={mayNeedUpdate}
        copiedTemplate={copiedTemplate}
        onCopyTemplate={() => void handleCopyTemplate()}
        onClearLegacyHooks={handleClearLegacyHooks}
        onUpdateSetupRunPolicy={(policy) =>
          updateSelectedRepoHookSettings({ setupRunPolicy: policy as SetupRunPolicy })
        }
      />
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
