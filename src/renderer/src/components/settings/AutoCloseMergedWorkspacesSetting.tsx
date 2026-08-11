import type { GlobalSettings } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'

export const AUTO_CLOSE_MERGED_WORKSPACES_KEYWORDS = [
  'auto close',
  'merged',
  'cleanup',
  'delete workspace',
  'remove worktree',
  'landed',
  'squash merge',
  'stale workspace',
  'worktree'
]

function getAutoCloseMergedWorkspacesTitle(): string {
  return translate(
    'auto.components.settings.GitPane.autoCloseMergedWorkspacesTitle',
    'Close Merged Workspaces Automatically'
  )
}

function getAutoCloseMergedWorkspacesDescription(): string {
  return translate(
    'auto.components.settings.GitPane.autoCloseMergedWorkspacesDescription',
    'Delete a local workspace once its branch has landed in the base branch, including squash merges. Orca keeps the workspace when it has uncommitted or untracked changes, when its branch was never pushed, when it is pinned, and always keeps the project checkout itself.'
  )
}

export function autoCloseMergedWorkspacesMatchesSearch(searchQuery: string): boolean {
  return matchesSettingsSearch(searchQuery, {
    title: getAutoCloseMergedWorkspacesTitle(),
    description: getAutoCloseMergedWorkspacesDescription(),
    keywords: AUTO_CLOSE_MERGED_WORKSPACES_KEYWORDS
  })
}

export function AutoCloseMergedWorkspacesSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): React.JSX.Element {
  const title = getAutoCloseMergedWorkspacesTitle()
  const description = getAutoCloseMergedWorkspacesDescription()

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={AUTO_CLOSE_MERGED_WORKSPACES_KEYWORDS}
      className="flex items-center justify-between gap-4 py-2"
    >
      <div className="space-y-0.5">
        <Label>{title}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch
        aria-label={title}
        checked={settings.autoCloseMergedWorktrees === true}
        onCheckedChange={(checked) => void updateSettings({ autoCloseMergedWorktrees: checked })}
      />
    </SearchableSetting>
  )
}
