import { Columns3, List } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { useTranslate } from '@/i18n/use-translate'
import type { JiraViewMode } from '../../jira-view-mode-storage'

type Props = {
  mode: JiraViewMode
  onModeChange: (mode: JiraViewMode) => void
  currentSprint: boolean
  onCurrentSprintChange: (checked: boolean) => void
  sprintDisabled?: boolean
}

export function TaskPageJiraViewControls({
  mode,
  onModeChange,
  currentSprint,
  onCurrentSprintChange,
  sprintDisabled = false
}: Props): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex flex-wrap items-center justify-end gap-3">
      <div className="flex items-center gap-2">
        <Switch
          id="jira-current-sprint"
          checked={currentSprint}
          onCheckedChange={onCurrentSprintChange}
          disabled={sprintDisabled}
        />
        <Label htmlFor="jira-current-sprint">
          {t('jira.board.currentSprint', 'Current sprint')}
        </Label>
      </div>
      <ToggleGroup
        type="single"
        value={mode}
        onValueChange={(value) => {
          if (value === 'list' || value === 'board') {
            onModeChange(value)
          }
        }}
        aria-label={t('jira.board.viewMode', 'Jira view')}
        variant="outline"
        size="sm"
      >
        <ToggleGroupItem value="list">
          <List />
          {t('jira.board.list', 'List')}
        </ToggleGroupItem>
        <ToggleGroupItem value="board">
          <Columns3 />
          {t('jira.board.board', 'Board')}
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  )
}
