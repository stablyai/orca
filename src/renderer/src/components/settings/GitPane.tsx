import type { GlobalSettings } from '../../../../shared/types'
import type { SourceControlAiSettingsPatch } from '../../../../shared/source-control-ai-types'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { useAppStore } from '../../store'
import { GIT_PANE_SEARCH_ENTRIES } from './git-search'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'
import { GitHubRateLimitPanel } from '../github/github-rate-limit-display'
import { AutoRenameBranchFromWorkSetting } from './AutoRenameBranchFromWorkSetting'
import { AUTO_RENAME_BRANCH_SEARCH_ENTRIES } from './auto-rename-branch-search'

export { GIT_PANE_SEARCH_ENTRIES }

export function shouldShowAutoRenameBranchSetting(
  searchQuery: string,
  hasUnsavedBranchPromptChanges: boolean
): boolean {
  return (
    hasUnsavedBranchPromptChanges ||
    matchesSettingsSearch(searchQuery, AUTO_RENAME_BRANCH_SEARCH_ENTRIES)
  )
}

type GitPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
  writeSourceControlAiSettings: (patch: SourceControlAiSettingsPatch) => Promise<void>
  displayedGitUsername: string
  hasUnsavedBranchPromptChanges?: boolean
  onBranchPromptDirtyChange?: (dirty: boolean) => void
  branchPromptDiscardSignal?: number
  settingsSearchQuery?: string
}

export function GitPane({
  settings,
  updateSettings,
  writeSourceControlAiSettings,
  displayedGitUsername,
  hasUnsavedBranchPromptChanges = false,
  onBranchPromptDirtyChange,
  branchPromptDiscardSignal,
  settingsSearchQuery
}: GitPaneProps): React.JSX.Element {
  const storeSearchQuery = useAppStore((s) => s.settingsSearchQuery)
  const searchQuery = settingsSearchQuery ?? storeSearchQuery

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
        <div className="space-y-0.5">
          <Label>Branch Prefix</Label>
          <p className="text-xs text-muted-foreground">
            Choose whether branch names use your Git username, a custom prefix, or no prefix.
          </p>
        </div>
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
      description:
        'Safely fast-forward local main or master so AI tools and diffs use a fresh base.',
      keywords: [
        'main',
        'master',
        'origin/main',
        'git diff',
        'base ref',
        'fresh base',
        'safely',
        'worktree'
      ]
    }) ? (
      <SearchableSetting
        key="refresh-base-ref"
        title="Refresh Local Base Ref"
        description="Safely fast-forward local main or master so AI tools and diffs use a fresh base."
        keywords={[
          'main',
          'master',
          'origin/main',
          'git diff',
          'base ref',
          'fresh base',
          'safely',
          'worktree'
        ]}
        className="flex items-center justify-between gap-4 py-2"
      >
        <div className="space-y-0.5">
          <Label>Refresh Local Base Ref</Label>
          <p className="text-xs text-muted-foreground">
            Turn this on if you or AI tools use commands like <code>git diff main...HEAD</code>.
            Orca first refreshes the remote base, then safely fast-forwards the matching local{' '}
            <code>main</code> or <code>master</code> so those commands do not compare against stale
            history. Orca skips the update if the local branch is dirty or diverged.
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
    shouldShowAutoRenameBranchSetting(searchQuery, hasUnsavedBranchPromptChanges) ? (
      <AutoRenameBranchFromWorkSetting
        key="auto-rename-branch-from-work"
        settings={settings}
        updateSettings={updateSettings}
        writeSourceControlAiSettings={writeSourceControlAiSettings}
        forceVisible={hasUnsavedBranchPromptChanges}
        onBranchPromptDirtyChange={onBranchPromptDirtyChange}
        branchPromptDiscardSignal={branchPromptDiscardSignal}
        settingsSearchQuery={searchQuery}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, {
      title: 'GitHub API Budget',
      description: 'Current GitHub CLI REST, Search, and GraphQL rate limits.',
      keywords: ['github', 'gh', 'graphql', 'rate limit', 'api budget']
    }) ? (
      <SearchableSetting
        key="github-api-budget"
        title="GitHub API Budget"
        description="Current GitHub CLI REST, Search, and GraphQL rate limits."
        keywords={['github', 'gh', 'graphql', 'rate limit', 'api budget']}
        className="space-y-3"
      >
        <GitHubRateLimitPanel />
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
        description="Add Orca attribution to commits, PRs, and issues."
        keywords={['github', 'gh', 'pr', 'issue', 'co-author', 'coauthored', 'attribution', 'orca']}
        className="flex items-center justify-between gap-4 py-2"
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
