// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { emitBotsChangedWindowEvent, onBotsChanged } from './bots-changed-window-event'
import { botGroupRoomConcerned, type BotChangeScope } from '../../../shared/bots/bot-change-scope'

// A room-scoped groups notice (#47523) reaches every bot view in the window. Guards that the notice is
// read once and shared, not copied per listener, and that only the named rooms' views re-read.

const stops: (() => void)[] = []
afterEach(() => stops.splice(0).forEach((stop) => stop()))

function dispatch(listeners: number, named: number) {
  const scopes: (BotChangeScope | undefined)[] = []
  let reads = 0
  for (let index = 0; index < listeners; index += 1) {
    stops.push(
      onBotsChanged(
        (_host, scope) => {
          scopes.push(scope)
          if (botGroupRoomConcerned(scope, `room-${index}`)) {
            reads += 1
          }
        },
        'local',
        { kinds: ['groups'] }
      )
    )
  }
  const groupIds = Array.from({ length: named }, (_, index) => `room-${index}`)
  emitBotsChangedWindowEvent('local', { kinds: ['groups'], groupIds })
  return { scopes: new Set(scopes).size, heard: scopes.length, reads }
}

it('reads a notice once for every listener and re-reads only the rooms it names', () => {
  expect(dispatch(100, 1)).toEqual({ scopes: 1, heard: 100, reads: 1 })
  stops.splice(0).forEach((stop) => stop())
  expect(dispatch(1_000, 10)).toEqual({ scopes: 1, heard: 1_000, reads: 10 })
})
