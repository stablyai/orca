import { describe, expect, it, vi } from 'vitest'

vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => ({ settings: {} }) }
}))

const { readTerminalClipboardSelection } = await import('./terminal-clipboard-selection-text')
const { setTerminalAgentOutputProbe } = await import('./terminal-agent-output-probe')

describe('readTerminalClipboardSelection', () => {
  it('joins hard-wrapped rows only in a pane that runs an agent', () => {
    const wrapped = ['  Retry limit is now five and the', '  backoff starts at 2s.'].join('\n')
    const terminal = (agent: boolean) => {
      const t = {
        getSelection: () => wrapped,
        getSelectionPosition: () => ({ start: { x: 0, y: 0 }, end: { x: 23, y: 1 } }),
        cols: 34
      }
      setTerminalAgentOutputProbe(t, () => agent)
      return t
    }
    expect(readTerminalClipboardSelection(terminal(true))).toBe(
      'Retry limit is now five and the backoff starts at 2s.'
    )
    expect(readTerminalClipboardSelection(terminal(false))).toBe(
      ['Retry limit is now five and the', 'backoff starts at 2s.'].join('\n')
    )
  })
})
