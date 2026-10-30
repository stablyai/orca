import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetPtyRendererDeliveryClaimsForTest,
  acquireHiddenRendererPtyDeliveryClaim,
  declareRendererPtyDeliveryVisible,
  releaseRendererPtyVisibilityClaim,
  setRendererPtyVisibilityClaim
} from './pty-renderer-delivery-claims'

const PTY_ID = 'workspace@@pty-1'

describe('renderer PTY delivery claims', () => {
  const setHiddenRendererPty = vi.fn()
  const setRendererPtyVisible = vi.fn()

  beforeEach(() => {
    _resetPtyRendererDeliveryClaimsForTest()
    setHiddenRendererPty.mockReset()
    setRendererPtyVisible.mockReset()
    ;(globalThis as { window: Window }).window = {
      api: { pty: { setHiddenRendererPty, setRendererPtyVisible } }
    } as unknown as Window
  })

  it('keeps a PTY hidden across an overlapping pane-to-watcher handoff', () => {
    const releasePane = acquireHiddenRendererPtyDeliveryClaim(PTY_ID)
    const releaseWatcher = acquireHiddenRendererPtyDeliveryClaim(PTY_ID)

    expect(setHiddenRendererPty).toHaveBeenCalledTimes(1)
    expect(setHiddenRendererPty).toHaveBeenLastCalledWith(PTY_ID, true)

    releasePane()
    expect(setHiddenRendererPty).toHaveBeenCalledTimes(1)

    declareRendererPtyDeliveryVisible(PTY_ID)
    expect(setHiddenRendererPty).toHaveBeenCalledTimes(1)

    releaseWatcher()
    expect(setHiddenRendererPty).toHaveBeenLastCalledWith(PTY_ID, false)
    expect(setHiddenRendererPty).toHaveBeenCalledTimes(2)
  })

  it('does not let a retiring visible pane hide its replacement', () => {
    const oldPane = {}
    const newPane = {}
    setRendererPtyVisibilityClaim(oldPane, PTY_ID, true)
    setRendererPtyVisibilityClaim(newPane, PTY_ID, true)

    expect(setRendererPtyVisible).toHaveBeenCalledTimes(1)
    releaseRendererPtyVisibilityClaim(oldPane)
    expect(setRendererPtyVisible).toHaveBeenCalledTimes(1)

    releaseRendererPtyVisibilityClaim(newPane)
    expect(setRendererPtyVisible).toHaveBeenLastCalledWith(PTY_ID, false)
    expect(setRendererPtyVisible).toHaveBeenCalledTimes(2)
  })

  it('reports a never-visible mounted pane as known hidden', () => {
    setRendererPtyVisibilityClaim({}, PTY_ID, false)
    expect(setRendererPtyVisible).toHaveBeenCalledWith(PTY_ID, false)
  })
})
