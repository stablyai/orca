import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ error: vi.fn() }))

vi.mock('sonner', () => ({ toast: { error: mocks.error } }))

import { roomErrorMessage, showRoomActionError } from './room-action-error'

beforeEach(() => mocks.error.mockClear())

it.each([
  ['room_delivery_queue_stale', "This action isn't valid for the current queue state."],
  ['room_stop_in_progress', 'The room is still stopping.'],
  ['room_agent_not_ready', 'An agent is not ready.'],
  ['room_agent_control_unsupported', 'This agent does not support that control.'],
  ['room_delivery_not_found', 'This queued delivery no longer exists.'],
  ['room_message_not_found', 'This message no longer exists.'],
  ['room_participant_not_found', 'That agent is no longer in the room.'],
  ['room_reply_not_found', 'The message you replied to is no longer available.']
])('maps %s to a human-readable room action error', (code, message) => {
  showRoomActionError(new Error(code))
  expect(mocks.error).toHaveBeenCalledWith(message)
})

it.each(['room_future_internal_code', 'conversation_future_internal_code'])(
  'hides unknown internal code %s',
  (code) => {
    showRoomActionError(new Error(code))
    expect(mocks.error).toHaveBeenCalledWith('Room action failed.')
  }
)

it('preserves human-readable errors after stripping the Electron wrapper', () => {
  showRoomActionError(
    new Error("Error invoking remote method 'rooms': Error: Please try that again.")
  )
  expect(mocks.error).toHaveBeenCalledWith('Please try that again.')
})

it('uses the caller fallback only for exact machine error codes', () => {
  expect(roomErrorMessage('room_turn_failed', 'Delivery failed.')).toBe('Delivery failed.')
  expect(roomErrorMessage('Provider rejected this prompt.', 'Delivery failed.')).toBe(
    'Provider rejected this prompt.'
  )
})
