import { translate } from '@/i18n/i18n'
import {
  resolveWorkItemStartPromptDelivery,
  type WorkItemStartPromptDelivery
} from '../../../../shared/work-item-start-prompt-delivery'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow, SettingsSegmentedControl } from './SettingsFormControls'
import { getWorkItemStartBehaviorSearchKeywords } from './tasks-search'

type WorkItemStartBehaviorSettingProps = {
  value: WorkItemStartPromptDelivery | undefined
  onChange: (value: WorkItemStartPromptDelivery) => void
}

export function WorkItemStartBehaviorSetting({
  value,
  onChange
}: WorkItemStartBehaviorSettingProps): React.JSX.Element {
  const label = translate(
    'auto.components.settings.TasksPane.workItemStartBehavior',
    'Work item Start behavior'
  )
  const description = translate(
    'auto.components.settings.TasksPane.workItemStartBehaviorDescription',
    'Choose whether Start leaves the work item prompt editable or submits it after the agent is ready.'
  )
  const draftLabel = translate('auto.components.settings.TasksPane.workItemStartDraft', 'Draft')
  const submitLabel = translate(
    'auto.components.settings.TasksPane.workItemStartSubmit',
    'Submit after ready'
  )

  return (
    <SearchableSetting
      title={label}
      description={description}
      keywords={getWorkItemStartBehaviorSearchKeywords()}
    >
      <SettingsRow
        label={label}
        description={description}
        control={
          <SettingsSegmentedControl<WorkItemStartPromptDelivery>
            size="sm"
            ariaLabel={label}
            value={resolveWorkItemStartPromptDelivery(value)}
            onChange={onChange}
            options={[
              { value: 'draft', label: draftLabel, ariaLabel: draftLabel },
              {
                value: 'submit-after-ready',
                label: submitLabel,
                ariaLabel: submitLabel
              }
            ]}
          />
        }
      />
    </SearchableSetting>
  )
}
