import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Guards #43465: atlas-memory rebuilds of every WebGL renderer stay one per output burst and ≥10 s apart.
const rebuildAll = vi.fn()
vi.mock('../pane-manager-registry', () => ({ rebuildAllTerminalWebglRenderers: rebuildAll }))

function fakeTerminal() {
  const listeners = new Set<() => void>()
  return {
    onWriteParsed(listener: () => void) {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
    write() {
      for (const listener of listeners) {
        listener()
      }
    }
  }
}

async function loadModule(userAgent: string) {
  vi.resetModules()
  vi.stubGlobal('navigator', { userAgent })
  return import('./terminal-webgl-atlas-memory-rebuild')
}

describe('terminal WebGL atlas-memory rebuild', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    rebuildAll.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('never rebuilds again from atlas pages that arrive without new output', async () => {
    const { handleTerminalWebglAtlasPage } = await loadModule('Macintosh')
    const terminal = fakeTerminal()
    handleTerminalWebglAtlasPage({ width: 4096 }, terminal)
    await vi.advanceTimersByTimeAsync(0)
    expect(rebuildAll).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 20; i++) {
      handleTerminalWebglAtlasPage({ width: 4096 }, terminal)
      await vi.advanceTimersByTimeAsync(60_000)
    }
    expect(rebuildAll).toHaveBeenCalledTimes(1)
  })

  it('rebuilds at most once per 10 s under sustained output', async () => {
    const { handleTerminalWebglAtlasPage } = await loadModule('Macintosh')
    const terminal = fakeTerminal()
    for (let i = 0; i < 60; i++) {
      terminal.write()
      handleTerminalWebglAtlasPage({ width: 4096 }, terminal)
      await vi.advanceTimersByTimeAsync(1_000)
    }
    // t = 0, 10, …, 60 s.
    expect(rebuildAll).toHaveBeenCalledTimes(7)
  })

  it('ignores other page sizes and non-Mac platforms', async () => {
    const mac = await loadModule('Macintosh')
    mac.handleTerminalWebglAtlasPage({ width: 2048 }, fakeTerminal())
    mac.handleTerminalWebglAtlasPage({ width: 16384 }, fakeTerminal())
    const windows = await loadModule('Windows NT 10.0')
    windows.handleTerminalWebglAtlasPage({ width: 4096 }, fakeTerminal())
    await vi.advanceTimersByTimeAsync(60_000)
    expect(rebuildAll).not.toHaveBeenCalled()
  })
})
