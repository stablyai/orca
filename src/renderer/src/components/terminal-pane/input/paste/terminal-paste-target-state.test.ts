import { describe, expect, it } from 'vitest'
import { isTerminalPanePasteTargetCurrent } from './terminal-paste-target-state'

describe('isTerminalPanePasteTargetCurrent', () => {
  it('keeps a paste for a remote terminal that takes input while its attachment settles', () => {
    const transport = {
      getPtyId: () => 'pty-1',
      isConnected: () => false,
      isHoldingInput: () => false,
      acceptsInputNow: () => true
    }
    const pane = { id: 1, leafId: 'leaf-1' }

    expect(
      isTerminalPanePasteTargetCurrent({
        manager: { getPanes: () => [pane] },
        paneTransports: new Map([[1, transport]]),
        paneId: 1,
        leafId: 'leaf-1',
        transport,
        ptyId: 'pty-1'
      })
    ).toBe(true)
  })
})
