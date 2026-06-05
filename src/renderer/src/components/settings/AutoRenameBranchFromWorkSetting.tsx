import type { GlobalSettings } from '../../../../shared/types'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'

type AutoRenameBranchFromWorkSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
  forceVisible?: boolean
}

export function AutoRenameBranchFromWorkSetting({
  settings,
  updateSettings,
  forceVisible = false
}: AutoRenameBranchFromWorkSettingProps): React.JSX.Element {
  return (
    <SearchableSetting
      title="Auto-Name From First Message"
      description="Use the first task to name blank new workspaces and their unpublished branches."
      keywords={[
        'workspace',
        'title',
        'branch',
        'rename',
        'name',
        'auto',
        'creature name',
        'agent',
        'prompt',
        'worktree',
        'model',
        'slug'
      ]}
      forceVisible={forceVisible}
      className="space-y-3 py-2"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label>Auto-name from first message</Label>
          <p className="text-xs text-muted-foreground">
            When a blank new workspace starts work, Orca uses the first task to rename the sidebar
            title and unpublished generated branch (e.g. <code>Nautilus</code>). Workspaces created
            from linked issues or pull requests are named up front from the same short identity.
            Tune the model and prompt under Git AI Author → Advanced → Branch Names.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={settings.autoRenameBranchFromWork}
          onClick={() =>
            updateSettings({
              autoRenameBranchFromWork: !settings.autoRenameBranchFromWork
            })
          }
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
            settings.autoRenameBranchFromWork ? 'bg-foreground' : 'bg-muted-foreground/30'
          }`}
        >
          <span
            className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
              settings.autoRenameBranchFromWork ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>
    </SearchableSetting>
  )
}
