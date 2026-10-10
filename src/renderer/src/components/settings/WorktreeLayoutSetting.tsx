import type React from 'react'
import { useId } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  buildWorktreeLayoutSettingsUpdate,
  isWorktreeLayout,
  resolveWorktreeLayout,
  type WorktreeLayout
} from '../../../../shared/worktree-layout'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'
import { buildWorktreeLayoutExamplePath } from './worktree-layout-example-path'
import { translate } from '@/i18n/i18n'

type WorktreeLayoutSettingProps = {
  settings: Pick<GlobalSettings, 'workspaceDir' | 'nestWorkspaces' | 'worktreeLayout'>
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

type WorktreeLayoutOption = {
  value: WorktreeLayout
  label: string
  detail: string
  example: string
}

function getWorktreeLayoutOptions(workspaceDir: string): WorktreeLayoutOption[] {
  return [
    {
      value: 'nested',
      label: translate('auto.components.settings.WorktreeLayoutSetting.nestedLabel', 'Nested'),
      detail: translate(
        'auto.components.settings.WorktreeLayoutSetting.nestedDetail',
        'Inside the workspace directory, in a folder named after the repository.'
      ),
      example: buildWorktreeLayoutExamplePath('nested', workspaceDir)
    },
    {
      value: 'flat',
      label: translate('auto.components.settings.WorktreeLayoutSetting.flatLabel', 'Flat'),
      detail: translate(
        'auto.components.settings.WorktreeLayoutSetting.flatDetail',
        'Directly inside the workspace directory.'
      ),
      example: buildWorktreeLayoutExamplePath('flat', workspaceDir)
    },
    {
      value: 'sibling',
      label: translate(
        'auto.components.settings.WorktreeLayoutSetting.siblingLabel',
        'Next to repository'
      ),
      detail: translate(
        'auto.components.settings.WorktreeLayoutSetting.siblingDetail',
        "In a .worktrees folder beside the repository, outside its working tree. Ignores the workspace directory; a project's Worktree Location still applies."
      ),
      example: buildWorktreeLayoutExamplePath('sibling', workspaceDir)
    }
  ]
}

export function WorktreeLayoutSetting({
  settings,
  updateSettings
}: WorktreeLayoutSettingProps): React.JSX.Element {
  const triggerId = useId()
  const layout = resolveWorktreeLayout(settings)
  const options = getWorktreeLayoutOptions(settings.workspaceDir)
  const active = options.find((option) => option.value === layout) ?? options[0]
  const title = translate(
    'auto.components.settings.WorktreeLayoutSetting.title',
    'Workspace Layout'
  )
  const description = translate(
    'auto.components.settings.WorktreeLayoutSetting.description',
    'Choose where new workspace folders are created.'
  )

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={['nested', 'flat', 'sibling', 'subfolder', 'directory', 'worktrees', 'layout']}
      className="space-y-2"
    >
      <div className="space-y-1">
        <Label htmlFor={triggerId}>{title}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Select
        value={layout}
        onValueChange={(next) => {
          if (isWorktreeLayout(next) && next !== layout) {
            updateSettings(buildWorktreeLayoutSettingsUpdate(next, settings))
          }
        }}
      >
        <SelectTrigger id={triggerId} className="w-64">
          <SelectValue>{active.label}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              <span className="min-w-0">
                <span className="block truncate">{option.label}</span>
                <span className="block truncate font-mono text-[11px] text-muted-foreground">
                  {option.example}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{active.detail}</p>
      <p className="font-mono text-[11px] text-muted-foreground">{active.example}</p>
    </SearchableSetting>
  )
}
