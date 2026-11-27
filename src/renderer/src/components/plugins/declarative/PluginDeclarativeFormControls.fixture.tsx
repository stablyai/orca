import { defineFixture } from '../../../component-fixtures/component-fixture'
import {
  PluginDeclarativeCheckbox,
  PluginDeclarativeRadioGroup
} from './PluginDeclarativeFormControls'

const emit = (): void => {}

const options = [
  { value: 'approve', label: 'Approve' },
  { value: 'requested_changes', label: 'Request changes' },
  { value: 'comment', label: 'Comment' }
]

export const radioGroupHorizontal = defineFixture({
  width: 360,
  render: () => (
    <PluginDeclarativeRadioGroup
      props={{
        label: 'Outcome',
        labelHidden: true,
        orientation: 'horizontal',
        options,
        defaultValue: 'requested_changes'
      }}
      emit={emit}
    />
  )
})

export const radioGroupWithDescriptions = defineFixture({
  width: 280,
  render: () => (
    <PluginDeclarativeRadioGroup
      props={{
        label: 'Outcome',
        options: [
          { value: 'approve', label: 'Approve', description: 'Merge once checks pass.' },
          {
            value: 'requested_changes',
            label: 'Request changes before this pull request can merge',
            description: 'Blocks the merge.'
          }
        ],
        defaultValue: 'approve'
      }}
      emit={emit}
    />
  )
})

export const checkbox = defineFixture({
  width: 280,
  render: () => (
    <div className="flex flex-col gap-3">
      <PluginDeclarativeCheckbox props={{ label: 'Notify reviewers' }} emit={emit} />
      <PluginDeclarativeCheckbox
        props={{
          label: 'Delete the branch after this pull request merges',
          description: 'Only the remote branch.',
          defaultChecked: true
        }}
        emit={emit}
      />
    </div>
  )
})
