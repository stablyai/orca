import { describe, expect, it, vi } from 'vitest'
import { repaintTerminalAfterImageAdded } from './terminal-image-added-repaint'

function makeAddon() {
  const listeners = new Set<() => void>()
  return {
    fire: () => listeners.forEach((listener) => listener()),
    onImageAdded: (listener: () => void) => {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    }
  }
}

describe('repaintTerminalAfterImageAdded', () => {
  it('repaints the whole viewport synchronously once per burst of added images', async () => {
    const coreRefresh = vi.fn()
    const terminal = { rows: 24, refresh: vi.fn(), _core: { refresh: coreRefresh } }
    const addon = makeAddon()
    repaintTerminalAfterImageAdded(terminal, addon)

    addon.fire()
    addon.fire()
    expect(coreRefresh).not.toHaveBeenCalled()
    await Promise.resolve()

    expect(coreRefresh).toHaveBeenCalledTimes(1)
    expect(coreRefresh).toHaveBeenCalledWith(0, 23, true)
    expect(terminal.refresh).not.toHaveBeenCalled()

    addon.fire()
    await Promise.resolve()
    expect(coreRefresh).toHaveBeenCalledTimes(2)
  })

  it('stops repainting once disposed, including a repaint already queued', async () => {
    const coreRefresh = vi.fn()
    const terminal = { rows: 24, refresh: vi.fn(), _core: { refresh: coreRefresh } }
    const addon = makeAddon()
    const subscription = repaintTerminalAfterImageAdded(terminal, addon)

    addon.fire()
    subscription?.dispose()
    addon.fire()
    await Promise.resolve()

    expect(coreRefresh).not.toHaveBeenCalled()
  })
})
