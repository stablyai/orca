// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoomEvent } from '../../../shared/rooms'
import { subscribeRoom } from './runtime-rooms-client'

const call = vi.fn()
let listener: ((payload: { roomId: string; event: RoomEvent }) => void) | undefined
const unsubscribe = vi.fn()

beforeEach(() => {
  call.mockReset()
  unsubscribe.mockReset()
  listener = undefined
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      runtime: {
        call,
        onRoomEvent: vi.fn((next) => {
          listener = next
          return unsubscribe
        })
      }
    }
  })
})

describe('subscribeRoom', () => {
  it('attaches before snapshot and replays events that arrive during activation', async () => {
    let resolveCall!: (value: unknown) => void
    call.mockReturnValue(new Promise((resolve) => (resolveCall = resolve)))
    const events: RoomEvent[] = []
    const pending = subscribeRoom({ kind: 'local' }, 'room-1', 'user', (event) =>
      events.push(event)
    )
    listener?.({
      roomId: 'room-1',
      event: { type: 'participant.removed', participantId: 'participant-1' }
    })
    resolveCall({ ok: true, result: { snapshot: { room: { id: 'room-1' } } } })
    const subscription = await pending

    expect(events.map((event) => event.type)).toEqual(['snapshot', 'participant.removed'])
    subscription.unsubscribe()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
