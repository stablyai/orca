import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { Bot } from '../../../../../shared/bot-types'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import { groupBotItems } from '../../../../../shared/bots/bot-item-groups'
import { botGroupFaces } from '../../../../../shared/bots/bot-group-face-layout'
import { BotAvatar } from '../BotAvatar'
import { BotGroupFaces } from '../BotGroupFaces'
import { renderBotGroupItemsAllClear, BotItemsAllClear } from './BotItemsAllClear'
import { BotItemsList } from './BotItemsList'

const now = Date.now()
const min = 60_000

const letterBot: Bot = {
  id: 'fixture-bot',
  name: 'Release helper',
  hostId: 'local',
  folder: 'release-helper',
  folderWorkspaceId: 'w1',
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
const mascotBot: Bot = { ...letterBot, avatar: 'mascot:A1' }

const items = [
  makeTestBotItem(41, {
    title: 'Pick a name for the export menu',
    status: 'planned',
    lastActivityAt: now - 20 * min
  }),
  ...['Ship the reconnect fix', 'Rename the Items tab', 'Draft release notes'].map((title, index) =>
    makeTestBotItem(30 - index, {
      title,
      status: 'done',
      lastActivityAt: now - (index + 1) * 45 * min
    })
  )
]

// Closed opens (its default is folded) so the line can be checked against the rows' text edge.
window.localStorage.setItem(
  'orca.bots.panelFolds',
  JSON.stringify({ [letterBot.id]: ['items-closed'] })
)

// The Items tab's top as the panel lays it out: header picture and name, then the all-clear line over the groups.
function Panel({ bot, group }: { bot: Bot; group?: readonly Bot[] }): React.JSX.Element {
  return (
    <div className="@container flex flex-col gap-3.5 bg-sidebar py-3 pl-3.5 pr-2">
      <div className="flex items-center gap-2.5 px-2 pb-1 pt-1">
        {group ? (
          <BotGroupFaces
            faces={botGroupFaces(group, (member) => member.id)}
            className="size-9"
            slot={36}
          />
        ) : (
          <BotAvatar bot={bot} className="size-9 rounded-[9px] text-base" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold leading-5">{bot.name}</div>
          <div className="truncate text-xs leading-4 text-muted-foreground">Idle</div>
        </div>
      </div>
      <BotItemsList
        allClear={group ? renderBotGroupItemsAllClear(group) : <BotItemsAllClear />}
        bot={bot}
        groups={groupBotItems(items, null, now, 'e10')}
        seenEventId="e10"
        closedTotal={3}
        onMoreClosed={null}
        staleDays={null}
        now={now}
        onOpen={() => {}}
      />
    </div>
  )
}

export const narrow = defineFixture({ width: 200, render: () => <Panel bot={mascotBot} /> })
export const wide = defineFixture({ width: 320, render: () => <Panel bot={mascotBot} /> })

const groupMembers: Bot[] = [
  mascotBot,
  { ...letterBot, id: 'fixture-bot-2', name: 'Docs writer', paused: true },
  { ...letterBot, id: 'fixture-bot-3', name: 'Triage', avatar: 'mascot:B1', paused: true }
]
export const groupNarrow = defineFixture({
  width: 200,
  render: () => <Panel bot={{ ...letterBot, name: 'Launch group' }} group={groupMembers} />
})
export const groupWide = defineFixture({
  width: 320,
  render: () => <Panel bot={{ ...letterBot, name: 'Launch group' }} group={groupMembers} />
})
export const groupAllPaused = defineFixture({
  width: 320,
  render: () => (
    <Panel
      bot={{ ...letterBot, name: 'Launch group' }}
      group={groupMembers.map((member) => ({ ...member, paused: true }))}
    />
  )
})
