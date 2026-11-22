import { describe, expect, it } from 'vitest'
import type { NativeChatMessageSlot } from './native-chat-transcript-slots'
import { nativeChatAnswerCardAt } from './native-chat-answer-card'

function agentRow(id: string, continuesTurn: boolean): NativeChatMessageSlot {
  return {
    kind: 'message',
    message: {
      id,
      role: 'assistant',
      timestamp: 0,
      source: 'transcript',
      blocks: [{ type: 'text', text: id }]
    },
    turnKey: 't1',
    activeTurnIsWorking: true,
    trailingRun: false,
    receipt: undefined,
    status: undefined,
    folded: false,
    drawsMessage: true,
    turnFolds: false,
    continuesTurn,
    turnDiff: undefined,
    estimatedHeight: 24
  }
}

describe('answer card edges', () => {
  const slots = [agentRow('a', true), agentRow('b', false)]
  const noMarker = { newRowsMarkerBelow: () => false }

  it('reaches across the 2-unit gap a tucked row leaves to the next step', () => {
    expect(
      nativeChatAnswerCardAt(slots, 0, { ...noMarker, joinsActivityAbove: () => false })
    ).toMatchObject({ joinsBelow: true, belowUnits: 2 })
  })

  it('stops where the next step begins when its activity join overlaps the tucked row', () => {
    const joinsActivityAbove = (index: number) => index === 1
    expect(nativeChatAnswerCardAt(slots, 0, { ...noMarker, joinsActivityAbove })).toMatchObject({
      joinsBelow: true,
      belowUnits: -2
    })
    expect(nativeChatAnswerCardAt(slots, 1, { ...noMarker, joinsActivityAbove })).toMatchObject({
      joinsAbove: true,
      aboveUnits: 0
    })
  })
})
