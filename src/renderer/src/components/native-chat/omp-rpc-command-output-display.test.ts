// The display boundary for OMP RPC command output. Asserts the invariant that
// makes `/usage` render colour-free: reducer state keeps the RAW capture and
// only the projection strips, so a colour sequence split across two
// `command-output` frames is whole by the time it is stripped.

import { describe, expect, it } from 'vitest'
import type { OmpRpcClientEvent } from '../../../../shared/omp-rpc-protocol'
import { ompRpcCommandOutputDisplayText } from './omp-rpc-command-output-display'
import { createInitialOmpRpcTurnState, ompRpcTurnReducer } from './omp-rpc-turn-reducer'
import { OMP_RPC_COMMAND_OUTPUT_ID, selectOmpRpcOverlayMessages } from './omp-rpc-turn-overlay'

const ESC = String.fromCharCode(27)
// The shape `/usage` actually paints: truecolour SGR around each cell.
const TRUECOLOUR_OPEN = `${ESC}[38;2;100;200;50m`
const SGR_RESET = `${ESC}[0m`

function commandOutputState(...frames: readonly string[]) {
  return frames.reduce(
    (state, text) =>
      ompRpcTurnReducer(state, {
        type: 'frame',
        event: { kind: 'command-output', text } satisfies OmpRpcClientEvent
      }),
    createInitialOmpRpcTurnState()
  )
}

function overlayCommandOutput(...frames: readonly string[]): string | null {
  const message = selectOmpRpcOverlayMessages(commandOutputState(...frames), []).find(
    (candidate) => candidate.id === OMP_RPC_COMMAND_OUTPUT_ID
  )
  if (!message) {
    return null
  }
  return message.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
}

describe('ompRpcCommandOutputDisplayText', () => {
  it('drops truecolour SGR sequences and keeps the text', () => {
    expect(ompRpcCommandOutputDisplayText(`${TRUECOLOUR_OPEN}Tokens: 42${SGR_RESET}`)).toBe(
      'Tokens: 42'
    )
  })

  it('leaves no colour-code digits behind', () => {
    expect(ompRpcCommandOutputDisplayText(`${TRUECOLOUR_OPEN}x`)).not.toContain('38;2;')
  })

  it('preserves tabs and line breaks', () => {
    expect(ompRpcCommandOutputDisplayText(`a\tb${SGR_RESET}\nc`)).toBe('a\tb\nc')
  })

  it('passes plain output through untouched', () => {
    expect(ompRpcCommandOutputDisplayText('Tokens: 42')).toBe('Tokens: 42')
  })
})

describe('command output stays raw in reducer state', () => {
  it('keeps the raw bytes rather than stripping at ingest', () => {
    expect(commandOutputState(`${TRUECOLOUR_OPEN}Tokens`).commandOutputText).toBe(
      `${TRUECOLOUR_OPEN}Tokens`
    )
  })

  it('strips a sequence whose introducer and body arrive in separate frames', () => {
    // Regression: stripping per frame ate the bare `ESC [` in frame one, so
    // frame two's `38;2;100;200;50m` rendered as visible text in the chat.
    expect(overlayCommandOutput(`${ESC}[`, '38;2;100;200;50mTokens: 42')).toBe('Tokens: 42')
  })

  it('strips a sequence split mid-parameter across two frames', () => {
    expect(overlayCommandOutput(`${ESC}[38;2;100`, ';200;50mTokens: 42')).toBe('Tokens: 42')
  })
})

describe('selectOmpRpcOverlayMessages command output', () => {
  it('renders colour-free output for a local command', () => {
    expect(overlayCommandOutput(`${TRUECOLOUR_OPEN}Tokens: 42${SGR_RESET}\n`)).toBe('Tokens: 42\n')
  })

  it('renders no row when the output is only colour codes', () => {
    expect(overlayCommandOutput(`${TRUECOLOUR_OPEN}${SGR_RESET}`)).toBeNull()
  })
})
