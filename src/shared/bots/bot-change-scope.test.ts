import { expect, it } from 'vitest'
import {
  addBotChange,
  botChangeNotice,
  botGroupRoomConcerned,
  pendingBotChanges,
  readBotChangeScope,
  type BotChangeScope
} from './bot-change-scope'

// One quiet window's notice, as it leaves the host and as a reader reads it back.
function notice(...changes: BotChangeScope[]): BotChangeScope | undefined {
  const pending = pendingBotChanges()
  changes.forEach((change) => addBotChange(pending, change))
  return readBotChangeScope(JSON.parse(JSON.stringify(botChangeNotice(pending))))
}

const rooms = (scope: BotChangeScope | undefined) =>
  ['room-a', 'room-b', 'room-c'].filter((id) => botGroupRoomConcerned(scope, id))

it('re-reads only the rooms a window named, and every room once a change names none', () => {
  const named = notice(
    { kinds: ['groups'], groupIds: ['room-a'] },
    { kinds: ['groups'], groupIds: ['room-b'] },
    { botIds: ['bot-1'], kinds: ['status'] }
  )
  expect(rooms(named)).toEqual(['room-a', 'room-b'])
  // A groups change that names no room (a roster edit, an older caller) reaches every room.
  expect(rooms(notice({ kinds: ['groups'], groupIds: ['room-a'] }, { kinds: ['groups'] }))).toEqual(
    ['room-a', 'room-b', 'room-c']
  )
  expect(rooms(notice({ kinds: ['groups'] }, { kinds: ['groups'], groupIds: ['room-a'] }))).toEqual(
    ['room-a', 'room-b', 'room-c']
  )
  expect(
    rooms(notice({ kinds: ['groups'], groupIds: [] }, { kinds: ['groups'], groupIds: ['room-a'] }))
  ).toHaveLength(3)
  // A change of every kind, an older host's bare notice, and a kind this build doesn't know all reach
  // every room; another kind alone reaches none.
  expect(rooms(notice({ kinds: ['groups'], groupIds: ['room-a'] }, {}))).toHaveLength(3)
  expect(rooms(undefined)).toHaveLength(3)
  expect(rooms(readBotChangeScope({ kinds: ['future-kind'], groupIds: ['room-a'] }))).toHaveLength(
    3
  )
  expect(rooms(notice({ botIds: ['bot-1'], kinds: ['status'] }))).toEqual([])
})

it('keeps the rooms a notice names when a window reads a notice the bridge already read', () => {
  const bridged = structuredClone(readBotChangeScope({ kinds: ['groups'], groupIds: ['room-a'] }))
  expect(rooms(readBotChangeScope(bridged))).toEqual(['room-a'])
})
