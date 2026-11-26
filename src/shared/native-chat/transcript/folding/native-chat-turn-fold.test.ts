import { describe, expect, it } from 'vitest'
import type { NativeChatBlock, NativeChatMessage } from '../../native-chat-types'
import { NATIVE_CHAT_ADVISOR_PRESENTATION } from '../notices/native-chat-notice'
import { nativeChatTurnFold, nativeChatTurnFoldRow } from './native-chat-turn-fold'

function foldedRows(turn: readonly [NativeChatMessage['role'], NativeChatBlock[]][]): number[] {
  const rows = turn.map(([role, blocks], index) =>
    nativeChatTurnFoldRow(
      { id: `m${index}`, role, blocks, timestamp: null, source: 'transcript' },
      't',
      undefined
    )
  )
  const fold = nativeChatTurnFold({
    rows,
    settledTurnKeys: new Set(['t']),
    expandedTurnKeys: new Set()
  })
  return [...fold.foldedRows].sort((a, b) => a - b)
}

const text = (value: string): NativeChatBlock => ({ type: 'text', text: value })
const call: NativeChatBlock = { type: 'tool-call', name: 'read', input: {} }
const result: NativeChatBlock = { type: 'tool-result', output: 'ok' }

const advisor = (note: string): NativeChatBlock => ({
  type: 'text',
  text: note,
  presentation: NATIVE_CHAT_ADVISOR_PRESENTATION
})

describe('nativeChatTurnFold', () => {
  it('keeps a words reply right before an advisor card and folds narration that work followed', () => {
    expect(
      foldedRows([
        ['user', [text('Fix it.')]],
        ['assistant', [text('Reading first.'), call]],
        ['tool', [result]],
        ['system', [advisor('Reviewer (concern): check callers')]],
        ['assistant', [text('Fixed, callers included.')]],
        ['system', [advisor('Reviewer (blocker): run the tests')]],
        ['assistant', [call]],
        ['tool', [result]],
        ['assistant', [text('Tests pass.')]]
      ])
    ).toEqual([1, 2, 3, 5, 6, 7])
  })

  it('keeps pre-tool headings and links visible when a turn settles', () => {
    expect(
      foldedRows([
        ['user', [text('Check the connection.')]],
        ['assistant', [text('Sign in at _https://example.invalid/device_'), call, result]],
        ['reasoning', [text('## Internal notes')]],
        ['assistant', [text('## Verification\nThe command checks the connection.'), call, result]],
        [
          'assistant',
          [
            text('Checking trace_https://status.'),
            call,
            { type: 'tool-result', output: 'https://example.invalid/log' }
          ]
        ],
        ['assistant', [text('The connection is ready.')]]
      ])
    ).toEqual([2, 4])
  })

  it('keeps the whole pre-tool reply when reasoning splits its heading from the other prose', () => {
    expect(
      foldedRows([
        ['user', [text('Check the connection.')]],
        ['assistant', [text('Here is what to expect.')]],
        ['reasoning', [text('Review the steps.')]],
        ['assistant', [text('## Verification')]],
        ['reasoning', [text('Check the details.')]],
        ['assistant', [text('The command checks the connection.')]],
        ['tool', [call, result]],
        ['assistant', [text('The connection is ready.')]]
      ])
    ).toEqual([2, 4, 6])
  })
})
