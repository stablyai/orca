import { defineFixture } from '../../../../../component-fixtures/component-fixture'
import { NativeChatModelCombobox } from './NativeChatModelCombobox'

const choices = [
  {
    value: 'GPT-6.1-Sol',
    label: 'GPT-6.1-Sol',
    description: 'Model load: 52%. Daily quota: 15% left (85% used); resets 06:00.'
  },
  {
    value: 'GPT-6-Astra',
    label: 'GPT-6-Astra',
    description: 'Model load: 352%. Weekly quota: 70% left (30% used); resets 00:00.'
  },
  { value: 'Seed-Code', label: 'Seed-Code' }
]

export const models = defineFixture({
  width: 520,
  render: () => (
    <div className="native-chat-appearance p-4">
      <NativeChatModelCombobox
        choices={choices}
        currentValue="GPT-6.1-Sol"
        readOnly={false}
        readOnlyReason={null}
        busy={false}
        onSelect={() => {}}
      />
    </div>
  )
})

export const narrow = defineFixture({ width: 320, render: models.render })
