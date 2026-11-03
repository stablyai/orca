import { defineFixture } from '../../component-fixtures/component-fixture'
import { EntryActionRow } from './TabBarCreateEntryRow'

const terminal = {
  id: 'new-terminal',
  kind: 'new-terminal',
  label: 'New terminal',
  keywords: []
} as const
const chat = {
  id: 'custom-chat:custom-reviewer',
  kind: 'custom-chat',
  label: 'Start a chat with Company reviewer',
  keywords: [],
  customChat: { agent: 'custom-reviewer', executionHostId: 'local' }
} as const

export const before = defineFixture({
  width: 340,
  render: () => (
    <div className="bg-popover p-2">
      <EntryActionRow
        id="terminal"
        option={{ kind: 'menu', option: terminal }}
        selected={false}
        onClick={() => {}}
      />
    </div>
  )
})

export const after = defineFixture({
  width: 340,
  render: () => (
    <div className="bg-popover p-2">
      <EntryActionRow
        id="chat"
        option={{ kind: 'menu', option: chat }}
        selected={false}
        onClick={() => {}}
      />
      <EntryActionRow
        id="terminal"
        option={{ kind: 'menu', option: terminal }}
        selected={false}
        onClick={() => {}}
      />
    </div>
  )
})
