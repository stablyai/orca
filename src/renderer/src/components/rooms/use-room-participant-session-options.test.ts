// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { RoomParticipant } from '../../../../shared/rooms'
import { useRoomParticipantSessionOptions } from './use-room-participant-session-options'

const target = { kind: 'local' } as const

function participant(terminalHandle: string | null): RoomParticipant {
  return {
    id: 'participant',
    agent: 'codex',
    worktreeId: null,
    terminalHandle,
    context: { model: 'gpt-5.6-sol', effort: 'high', fastMode: false }
  } as RoomParticipant
}

describe('useRoomParticipantSessionOptions', () => {
  it('preserves the option surface when a restored participant gets a new handle', () => {
    const { result, rerender } = renderHook(
      ({ terminalHandle }) => useRoomParticipantSessionOptions(participant(terminalHandle), target),
      { initialProps: { terminalHandle: 'old-handle' as string | null } }
    )
    const original = result.current.surface

    rerender({ terminalHandle: 'restored-handle' })
    expect(result.current.surface).toBe(original)

    rerender({ terminalHandle: null })
    expect(result.current.surface).toBeNull()

    rerender({ terminalHandle: 'new-session-handle' })
    expect(result.current.surface).not.toBe(original)
  })
})
