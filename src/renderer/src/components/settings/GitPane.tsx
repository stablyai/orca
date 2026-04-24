import type { GlobalSettings } from '../../../../shared/types'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { useAppStore } from '../../store'
import { GIT_PANE_SEARCH_ENTRIES } from './git-search'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'

export { GIT_PANE_SEARCH_ENTRIES }

type GitPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  displayedGitUsername: string
}

export function GitPane({
  settings,
  updateSettings,
  displayedGitUsername
}: GitPaneProps): React.JSX.Element {
  const searchQuery = useAppStore((s) => s.settingsSearchQuery)

  const visibleSections = [
    matchesSettingsSearch(searchQuery, {
      title: 'Branch Prefix',
      description: 'Prefix added to branch names when creating worktrees.',
      keywords: ['branch naming', 'git username', 'custom']
    }) ? (
      <SearchableSetting
        key="branch-prefix"
        title="Branch Prefix"
        description="Prefix added to branch names when creating worktrees."
        keywords={['branch naming', 'git username', 'custom']}
        className="space-y-3"
      >
        <div className="flex w-fit gap-1 rounded-md border border-border/50 p-1">
          {(['git-username', 'custom', 'none'] as const).map((option) => (
            <button
              key={option}
              onClick={() => updateSettings({ branchPrefix: option })}
              className={`rounded-sm px-3 py-1 text-sm transition-colors ${
                settings.branchPrefix === option
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {option === 'git-username' ? 'Git Username' : option === 'custom' ? 'Custom' : 'None'}
            </button>
          ))}
        </div>
        {(settings.branchPrefix === 'custom' || settings.branchPrefix === 'git-username') && (
          <Input
            value={
              settings.branchPrefix === 'git-username'
                ? displayedGitUsername
                : settings.branchPrefixCustom
            }
            onChange={(e) => updateSettings({ branchPrefixCustom: e.target.value })}
            placeholder={
              settings.branchPrefix === 'git-username'
                ? 'No git username configured'
                : 'e.g. feature'
            }
            className="max-w-xs"
            readOnly={settings.branchPrefix === 'git-username'}
          />
        )}
      </SearchableSetting>
    ) : null,
    matchesSettingsSearch(searchQuery, {
      title: 'Refresh Local Base Ref',
      description: 'Optionally fast-forward local main or master when creating worktrees.',
      keywords: ['main', 'master', 'origin/main', 'git diff', 'base ref', 'worktree']
    }) ? (
      <SearchableSetting
        key="refresh-base-ref"
        title="Refresh Local Base Ref"
        description="Optionally fast-forward local main or master when creating worktrees."
        keywords={['main', 'master', 'origin/main', 'git diff', 'base ref', 'worktree']}
        className="flex items-center justify-between gap-4 px-1 py-2"
      >
        <div className="space-y-0.5">
          <Label>Refresh Local Base Ref</Label>
          <p className="text-xs text-muted-foreground">
            When enabled, Orca updates your local <code>main</code> or <code>master</code> before
            creating a worktree. This helps AI tools and diffs compare your branch against the
            latest base branch. Orca only does this when it is safe.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={settings.refreshLocalBaseRefOnWorktreeCreate}
          onClick={() =>
            updateSettings({
              refreshLocalBaseRefOnWorktreeCreate: !settings.refreshLocalBaseRefOnWorktreeCreate
            })
          }
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
            settings.refreshLocalBaseRefOnWorktreeCreate
              ? 'bg-foreground'
              : 'bg-muted-foreground/30'
          }`}
        >
          <span
            className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
              settings.refreshLocalBaseRefOnWorktreeCreate ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </SearchableSetting>
    ) : null,
    matchesSettingsSearch(searchQuery, {
      title: 'Orca Attribution',
      description: 'Add Orca attribution to commits, PRs, and issues.',
      keywords: ['github', 'gh', 'pr', 'issue', 'co-author', 'coauthored', 'attribution', 'orca']
    }) ? (
      <SearchableSetting
        key="github-attribution"
        title="Orca Attribution"
        description="Add Orca attribution."
        keywords={['github', 'gh', 'pr', 'issue', 'co-author', 'coauthored', 'attribution', 'orca']}
        className="flex items-center justify-between gap-4 px-1 py-2"
      >
        <div className="space-y-0.5">
          <Label>Orca Attribution</Label>
          <p className="text-xs text-muted-foreground">
            Add Orca attribution to commits, PRs, and issues.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={settings.enableGitHubAttribution}
          onClick={() =>
            updateSettings({
              enableGitHubAttribution: !settings.enableGitHubAttribution
            })
          }
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
            settings.enableGitHubAttribution ? 'bg-foreground' : 'bg-muted-foreground/30'
          }`}
        >
          <span
            className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
              settings.enableGitHubAttribution ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </SearchableSetting>
    ) : null
  ].filter(Boolean)

  return <div className="space-y-4">{visibleSections}</div>
}
