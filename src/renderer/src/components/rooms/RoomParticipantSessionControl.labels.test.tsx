// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_ROOM_CONTEXT, type RoomParticipant } from '../../../../shared/rooms'

const controls = vi.hoisted(() => vi.fn((_props: unknown) => null))
vi.mock('../agent-session-controls/AgentSessionControls', () => ({
  AgentSessionControls: controls
}))
vi.mock('./use-room-participant-session-options', () => ({
  useRoomParticipantSessionOptions: () => ({
    surface: null,
    snapshot: [],
    canCompact: false,
    refreshMachineOptions: vi.fn()
  })
}))
import { RoomParticipantSessionControl } from './RoomParticipantSessionControl'
afterEach(cleanup)

describe('sleeping room participant labels', () => {
  it.each([
    ['claude', 'fable[1m]', 'Fable'],
    ['openclaude', 'claude-fable-5[1m]', 'Fable'],
    ['claude', 'custom-model[1m]', 'custom-model[1m]'],
    ['codex', 'gpt-5.6-sol', 'GPT-5.6 Sol'],
    ['codex', 'gpt-6-astra', 'gpt-6-astra']
  ] as const)('labels %s model %s without altering its saved id', (agent, model, expected) => {
    const participant = {
      id: 'p',
      agent,
      identity: agent,
      state: 'sleeping',
      participation: 'active',
      context: { ...EMPTY_ROOM_CONTEXT, model, effort: 'high' }
    } as RoomParticipant
    render(<RoomParticipantSessionControl participant={participant} target={{ kind: 'local' }} />)
    expect(controls.mock.calls.at(-1)?.[0]).toMatchObject({
      fallbackModelLabel: expected,
      fallbackOptionLabel: 'High'
    })
    expect(participant.context.model).toBe(model)
  })
})
