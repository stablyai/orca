import { describe, expect, it } from 'vitest'
import { isTerminalPanePasteTargetCurrent } from './terminal-paste-target-state'

const manager = {
  getPanes: () => [{ id: 7, leafId: 'leaf-a' }]
}

describe('isTerminalPanePasteTargetCurrent', () => {
  it('accepts paste into an unbound pane that is still holding input', () => {
    let connected = false
    let livePtyId: string | null = null
    const transport = {
      getPtyId: () => livePtyId,
      isConnected: () => connected,
      holdsInputUntilConnect: () => true
    }
    const paneTransports = new Map([[7, transport]])

    expect(
      isTerminalPanePasteTargetCurrent({
        manager,
        paneTransports,
        paneId: 7,
        leafId: 'leaf-a',
        transport,
        ptyId: null
      })
    ).toBe(true)

    connected = true
    livePtyId = 'pty-new'
    expect(
      isTerminalPanePasteTargetCurrent({
        manager,
        paneTransports,
        paneId: 7,
        leafId: 'leaf-a',
        transport,
        ptyId: null
      })
    ).toBe(true)
  })

  it('keeps a connected pane current only while its PTY id matches', () => {
    const transport = {
      getPtyId: () => 'pty-1',
      isConnected: () => true,
      holdsInputUntilConnect: () => false
    }
    const paneTransports = new Map([[7, transport]])

    expect(
      isTerminalPanePasteTargetCurrent({
        manager,
        paneTransports,
        paneId: 7,
        leafId: 'leaf-a',
        transport,
        ptyId: 'pty-1'
      })
    ).toBe(true)
    expect(
      isTerminalPanePasteTargetCurrent({
        manager,
        paneTransports,
        paneId: 7,
        leafId: 'leaf-a',
        transport,
        ptyId: 'pty-2'
      })
    ).toBe(false)
  })

  it('still rejects paste after a pane that already had a PTY disconnects', () => {
    const transport = {
      getPtyId: () => 'pty-1',
      isConnected: () => false,
      holdsInputUntilConnect: () => true
    }
    const paneTransports = new Map([[7, transport]])

    expect(
      isTerminalPanePasteTargetCurrent({
        manager,
        paneTransports,
        paneId: 7,
        leafId: 'leaf-a',
        transport,
        ptyId: 'pty-1'
      })
    ).toBe(false)
  })
})
