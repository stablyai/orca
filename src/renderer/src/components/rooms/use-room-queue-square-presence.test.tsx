// @vitest-environment happy-dom

import { renderHook, waitFor } from '@testing-library/react'
import { useCallback } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { RoomParticipant } from '../../../../shared/rooms'
import type { RoomQueueState } from './room-queue-state'
import { useRoomQueueSquarePresence } from './use-room-queue-square-presence'

vi.mock('@/hooks/usePrefersReducedMotion', () => ({
  usePrefersReducedMotion: () => false
}))

const participants = [{ id: 'alpha' }, { id: 'beta' }] as RoomParticipant[]
const state = { participants } as RoomQueueState

describe('useRoomQueueSquarePresence', () => {
  it('keeps newly visible squares in participant order', async () => {
    const { result, rerender } = renderHook(
      ({ directed }) => {
        const directedRows = useCallback(
          (participantId: string) => (directed.includes(participantId) ? [{}] : []),
          [directed]
        )
        return useRoomQueueSquarePresence({
          state,
          dragging: false,
          dragSettling: false,
          keptSquareId: null,
          expandedId: null,
          directedRows,
          closeExpanded: vi.fn()
        })
      },
      { initialProps: { directed: ['beta'] } }
    )

    await waitFor(() => expect(result.current.squares.map(({ id }) => id)).toEqual(['beta']))
    rerender({ directed: ['alpha', 'beta'] })
    await waitFor(() =>
      expect(result.current.squares.map(({ id }) => id)).toEqual(['alpha', 'beta'])
    )
  })
})
