import { roomMessageFixture, roomSnapshotFixture } from '../../../../shared/rooms.test-fixture'
import { EMPTY_ACTIVE_ROOM } from './room-event-reducer'
import type { RoomData } from './use-room-data'

export function roomDataFixture(
  overrides: Omit<Partial<RoomData>, 'snapshot' | 'messages'> & {
    snapshot?: Parameters<typeof roomSnapshotFixture>[0] | null
    messages?: Parameters<typeof roomMessageFixture>[0][]
  } = {}
): RoomData {
  return {
    ...EMPTY_ACTIVE_ROOM,
    target: { kind: 'local' },
    roomId: null,
    readerKey: 'user',
    rooms: [],
    loading: false,
    error: null,
    hasMore: false,
    pendingSteerIds: new Set(),
    steerDelivery: unexpected,
    loadOlder: unexpected,
    ...overrides,
    snapshot: overrides.snapshot ? roomSnapshotFixture(overrides.snapshot) : null,
    messages: (overrides.messages ?? []).map(roomMessageFixture)
  }
}

function unexpected(): never {
  throw new Error('Unexpected room action in test')
}
