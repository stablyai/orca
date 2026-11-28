import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { Bot } from '../../../../../shared/bot-types'
import { BotItemsFilterButton } from './BotItemsFilter'

const bot: Bot = {
  id: 'fixture',
  name: 'Example agent',
  hostId: 'local',
  folder: 'example',
  folderWorkspaceId: 'fixture',
  agent: 'codex',
  avatar: null,
  paused: false,
  permissionMode: 'ask',
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  chatSessionId: null,
  linear: null,
  github: null,
  createdAt: 1,
  updatedAt: 1
}
const render = () => (
  <div className="h-80 bg-background p-4">
    <BotItemsFilterButton
      items={[]}
      filter={{ chatIds: null, botIds: null, needsYou: false }}
      onFilter={() => {}}
      group={{
        bots: [{ bot, count: 2 }],
        cleared: { chatIds: null, botIds: null, needsYou: false },
        named: null
      }}
    />
  </div>
)
const interact = (frame: HTMLElement) => {
  frame
    .querySelector('button')
    ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false }))
}
export const regular = defineFixture({ width: 400, render, interact })
export const narrow = defineFixture({ width: 240, render, interact })

const people = [
  { accountId: 'a', name: 'Alice Park' },
  { accountId: 'b', name: 'Bo Chen' },
  { accountId: 'd', name: 'Dana Reyes' }
]
// A shared agent's menu: whose items, the owner's own picked by default, then Needs you only.
export const people_default = defineFixture({
  width: 400,
  render: () => (
    <div className="flex h-80 justify-end bg-background p-4">
      <BotItemsFilterButton
        items={[]}
        filter={{ chatIds: null, botIds: null, needsYou: false }}
        onFilter={() => {}}
        people={{
          entries: [
            { pick: { kind: 'owner' }, label: 'Jinwoo (you)' },
            ...people.map((person) => ({
              pick: { kind: 'person' as const, person },
              label: person.name
            }))
          ],
          pick: { kind: 'owner' },
          onPick: () => {}
        }}
      />
    </div>
  ),
  interact
})
