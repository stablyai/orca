import { defineFixture } from '../../component-fixtures/component-fixture'
import { ChatUiSwitchedCornerNote } from './ChatUiSwitchedCornerNote'

export const open = defineFixture({
  width: 360,
  render: () => <ChatUiSwitchedCornerNote onClose={() => {}} />
})
