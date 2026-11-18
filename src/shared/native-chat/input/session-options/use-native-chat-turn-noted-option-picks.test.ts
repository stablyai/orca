// @vitest-environment happy-dom
import * as React from 'react'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { SessionOptionDescriptor } from '../native-chat-session-options'
import { createNativeChatTurnNotedOptionPicksHook } from './use-native-chat-turn-noted-option-picks'

const useNotedPicks = createNativeChatTurnNotedOptionPicksHook(React)

function model(currentValue: string): SessionOptionDescriptor[] {
  return [
    {
      id: 'model',
      label: 'Model',
      category: 'model',
      kind: {
        type: 'select',
        currentValue,
        choices: [
          { value: 'opus', label: 'Opus' },
          { value: 'sonnet', label: 'Sonnet' }
        ]
      },
      valueSource: 'unknown',
      transport: 'agent-session',
      settable: true
    }
  ]
}

describe('useNativeChatTurnNotedOptionPicks', () => {
  it('keeps the earlier pick marked when going back to the starting model is refused', async () => {
    let applied = true
    const { result, rerender } = renderHook(
      ({ snapshot }) =>
        useNotedPicks({
          scope: 'chat-1',
          isWorking: true,
          snapshot,
          setOption: async () => applied,
          refused: (ok: boolean) => !ok
        }),
      { initialProps: { snapshot: model('opus') } }
    )

    await act(() => result.current.setOption('model', 'sonnet'))
    rerender({ snapshot: model('sonnet') })
    expect(result.current.snapshot[0].appliesAfterTurn).toBe(true)

    applied = false
    await act(() => result.current.setOption('model', 'opus'))

    expect(result.current.snapshot[0].appliesAfterTurn).toBe(true)
  })
})
