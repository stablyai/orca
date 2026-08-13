import type { GlobalSettings } from '../../../../shared/types'
import {
  DEFAULT_MERGED_WORKTREE_AUTO_CLOSE_GRACE_MINUTES,
  MAX_MERGED_WORKTREE_AUTO_CLOSE_GRACE_MINUTES,
  MIN_MERGED_WORKTREE_AUTO_CLOSE_GRACE_MINUTES,
  resolveMergedWorktreeAutoCloseGraceMs
} from '../../../../shared/merged-worktree-auto-close'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { NumberField } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'

const MS_PER_MINUTE = 60 * 1000

export const AUTO_CLOSE_MERGED_WORKSPACES_KEYWORDS = [
  'auto close',
  'merged',
  'cleanup',
  'delete workspace',
  'remove worktree',
  'landed',
  'squash merge',
  'stale workspace',
  'worktree',
  'grace period'
]

/** Read through `translate` on every call so a language switch re-renders the title. */
function getAutoCloseMergedWorkspacesTitle(): string {
  return translate(
    'auto.components.settings.GitPane.autoCloseMergedWorkspacesTitle',
    'Close Merged Workspaces Automatically'
  )
}

/**
 * The description doubles as search text, so it names every rail that keeps a
 * workspace — a user searching "pinned" or "uncommitted" should land here.
 */
function getAutoCloseMergedWorkspacesDescription(): string {
  return translate(
    'auto.components.settings.GitPane.autoCloseMergedWorkspacesDescription',
    'Delete a local workspace once its branch has landed in the base branch, including squash merges. Orca keeps the workspace when it has uncommitted or untracked changes, when its branch was never pushed, when it is pinned, and always keeps the project checkout itself.'
  )
}

/** Whether the settings search should reveal this row. */
export function autoCloseMergedWorkspacesMatchesSearch(searchQuery: string): boolean {
  return matchesSettingsSearch(searchQuery, {
    title: getAutoCloseMergedWorkspacesTitle(),
    description: getAutoCloseMergedWorkspacesDescription(),
    keywords: AUTO_CLOSE_MERGED_WORKSPACES_KEYWORDS
  })
}

/**
 * The Git-settings row for the landed-workspace automation: the opt-in switch,
 * and the grace window it reveals only while the automation is on — a window
 * with nothing to delay is noise.
 */
export function AutoCloseMergedWorkspacesSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): React.JSX.Element {
  const title = getAutoCloseMergedWorkspacesTitle()
  const description = getAutoCloseMergedWorkspacesDescription()
  const enabled = settings.autoCloseMergedWorktrees === true
  // Why resolve rather than read: the sweep decides on the resolved window, so
  // the field must show the same value a stale or absent setting resolves to.
  const graceMinutes =
    resolveMergedWorktreeAutoCloseGraceMs(settings.autoCloseMergedWorktreesGraceMinutes) /
    MS_PER_MINUTE

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={AUTO_CLOSE_MERGED_WORKSPACES_KEYWORDS}
      className="py-2"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label>{title}</Label>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <Switch
          aria-label={title}
          checked={enabled}
          onCheckedChange={(checked) => void updateSettings({ autoCloseMergedWorktrees: checked })}
        />
      </div>
      {enabled ? (
        <NumberField
          label={translate(
            'auto.components.settings.GitPane.autoCloseMergedWorkspacesGraceLabel',
            'Wait before closing'
          )}
          description={translate(
            'auto.components.settings.GitPane.autoCloseMergedWorkspacesGraceDescription',
            'How many minutes a workspace must have existed before Orca may close it. Set this to 0 to close a workspace as soon as its branch has landed. The default protects a workspace created from a branch that was already merged.'
          )}
          value={graceMinutes}
          defaultValue={DEFAULT_MERGED_WORKTREE_AUTO_CLOSE_GRACE_MINUTES}
          min={MIN_MERGED_WORKTREE_AUTO_CLOSE_GRACE_MINUTES}
          max={MAX_MERGED_WORKTREE_AUTO_CLOSE_GRACE_MINUTES}
          step={1}
          suffix={translate(
            'auto.components.settings.GitPane.autoCloseMergedWorkspacesGraceSuffix',
            'minutes'
          )}
          onChange={(minutes) =>
            void updateSettings({ autoCloseMergedWorktreesGraceMinutes: minutes })
          }
        />
      ) : null}
    </SearchableSetting>
  )
}
