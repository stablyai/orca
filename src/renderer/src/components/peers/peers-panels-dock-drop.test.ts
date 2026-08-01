import { describe, expect, it } from 'vitest'
import { resolvePeersDockDrop, type PeersDockDropEvent } from './peers-panels-dock-drop'

function baseEvent(overrides: Partial<PeersDockDropEvent> = {}): PeersDockDropEvent {
  return {
    activeData: { type: 'peers-tab', tab: { hostId: 'host-a', handle: 'term-2', title: 'Shell' } },
    activeTranslatedRect: { left: 100, top: 130, width: 20, height: 20 },
    overData: { type: 'peers-dock-pane', leafKey: 'host-a:term-1' },
    overRect: { left: 100, top: 100, width: 200, height: 100 },
    ...overrides
  }
}

describe('resolvePeersDockDrop', () => {
  it('resolves a split action when the drag ends near a pane edge', () => {
    // active center at (110, 140) -> local (10, 40) inside a 200x100 pane -> left edge, within band
    expect(resolvePeersDockDrop(baseEvent())).toEqual({
      atLeafKey: 'host-a:term-1',
      side: 'left',
      newTarget: { hostId: 'host-a', handle: 'term-2', title: 'Shell' }
    })
  })

  it('returns null when the payload is not a peers-tab drag', () => {
    expect(resolvePeersDockDrop(baseEvent({ activeData: { type: 'something-else' } }))).toBeNull()
  })

  it('returns null when not dropped over a dock pane', () => {
    expect(resolvePeersDockDrop(baseEvent({ overData: { type: 'peers-tab' } }))).toBeNull()
  })

  it('returns null when geometry has not been measured yet', () => {
    expect(resolvePeersDockDrop(baseEvent({ activeTranslatedRect: null }))).toBeNull()
  })

  it('returns null when dropped in the pane center, outside every edge band', () => {
    expect(
      resolvePeersDockDrop(
        baseEvent({ activeTranslatedRect: { left: 190, top: 140, width: 20, height: 20 } })
      )
    ).toBeNull()
  })

  it('returns null when the dragged tab is dropped on its own pane', () => {
    expect(
      resolvePeersDockDrop(
        baseEvent({ overData: { type: 'peers-dock-pane', leafKey: 'host-a:term-2' } })
      )
    ).toBeNull()
  })
})
