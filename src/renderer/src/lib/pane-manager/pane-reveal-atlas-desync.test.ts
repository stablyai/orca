// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from './pane-manager-types'

const mocks = vi.hoisted(() => ({
  presentPaneViewport: vi.fn(),
  reattachWebglIfNeeded: vi.fn(),
  resetAndRefreshAllTerminalWebglAtlases: vi.fn()
}))

vi.mock('./pane-webgl-reattach', () => ({
  reattachWebglIfNeeded: mocks.reattachWebglIfNeeded
}))

vi.mock('./pane-webgl-renderer', () => ({
  presentPaneViewport: mocks.presentPaneViewport
}))

vi.mock('./pane-manager-registry', () => ({
  resetAndRefreshAllTerminalWebglAtlases: mocks.resetAndRefreshAllTerminalWebglAtlases
}))

import { hasPaneWebglAtlasVersionDesync } from './pane-webgl-atlas-version-desync'
import { schedulePaneRevealPresent } from './pane-reveal-repaint'

type FakeAtlasOptions = {
  atlasLayoutVersion?: number
  glyphLayoutVersion?: number
  atlasPageVersions?: number[]
  glyphTextureVersions?: number[]
  isPaused?: boolean
  synchronizedOutput?: boolean
  displayNone?: boolean
  webglAttached?: boolean
  contextLostDisabled?: boolean
}

function makeFakePane(options: FakeAtlasOptions = {}): ManagedPaneInternal {
  const container = document.createElement('div')
  if (options.displayNone) {
    container.style.display = 'none'
  }
  document.body.appendChild(container)

  const terminal = {
    rows: 24,
    cols: 80,
    element: container,
    _core: {
      coreService: {
        decPrivateModes: {
          synchronizedOutput: options.synchronizedOutput ?? false
        }
      },
      _renderService: {
        _isPaused: options.isPaused ?? false,
        _renderer: {
          value: {
            _charAtlas: {
              pageLayoutVersion: options.atlasLayoutVersion ?? 3,
              pages: (options.atlasPageVersions ?? [5, 2]).map((version) => ({ version }))
            },
            _glyphRenderer: {
              value: {
                _lastSeenPageLayoutVersion: options.glyphLayoutVersion ?? 3,
                _atlasTextures: (options.glyphTextureVersions ?? [5, 2]).map((version) => ({
                  version
                }))
              }
            }
          }
        }
      }
    }
  }

  return {
    id: 1,
    container,
    terminal,
    webglAddon: (options.webglAttached ?? true) ? ({} as never) : null,
    webglDisabledAfterContextLoss: options.contextLostDisabled ?? false
  } as unknown as ManagedPaneInternal
}

describe('WebGL shared glyph atlas version desync detection and reveal recovery', () => {
  let frames: FrameRequestCallback[]

  function flushSettledFrames(): void {
    for (let step = 0; step < 2; step++) {
      const batch = frames
      frames = []
      for (const cb of batch) {
        cb(16)
      }
    }
  }

  beforeEach(() => {
    frames = []
    mocks.presentPaneViewport.mockReset()
    mocks.reattachWebglIfNeeded.mockReset()
    mocks.resetAndRefreshAllTerminalWebglAtlases.mockReset()
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb)
      return frames.length
    })
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('reports coherent WebGL panes without triggering global atlas reset on reveal', () => {
    const pane = makeFakePane()
    expect(hasPaneWebglAtlasVersionDesync(pane)).toBe(false)

    schedulePaneRevealPresent(() => [pane])
    flushSettledFrames()

    expect(mocks.reattachWebglIfNeeded).toHaveBeenCalledWith(pane)
    expect(mocks.presentPaneViewport).toHaveBeenCalledWith(pane)
    expect(mocks.resetAndRefreshAllTerminalWebglAtlases).not.toHaveBeenCalled()
  })

  it('escalates once per settled reveal when pageLayoutVersion or page texture versions still lag after present', () => {
    const layoutDesynced = makeFakePane({ atlasLayoutVersion: 4, glyphLayoutVersion: 2 })
    const textureDesynced = makeFakePane({
      atlasPageVersions: [7, 3],
      glyphTextureVersions: [7, 1]
    })

    expect(hasPaneWebglAtlasVersionDesync(layoutDesynced)).toBe(true)
    expect(hasPaneWebglAtlasVersionDesync(textureDesynced)).toBe(true)

    schedulePaneRevealPresent(() => [layoutDesynced, textureDesynced])
    flushSettledFrames()

    expect(mocks.presentPaneViewport).toHaveBeenCalledTimes(2)
    expect(mocks.resetAndRefreshAllTerminalWebglAtlases).toHaveBeenCalledTimes(1)
    expect(mocks.resetAndRefreshAllTerminalWebglAtlases).toHaveBeenCalledWith(
      'reveal-atlas-version-desync'
    )
  })

  it('does not escalate when presentPaneViewport reconciles the glyph renderer during reveal', () => {
    const pane = makeFakePane({ atlasLayoutVersion: 5, glyphLayoutVersion: 4 })
    mocks.presentPaneViewport.mockImplementation((target: ManagedPaneInternal) => {
      const glyph = (
        target.terminal as unknown as {
          _core: { _renderService: { _renderer: { value: { _glyphRenderer: { value: { _lastSeenPageLayoutVersion: number } } } } } }
        }
      )._core._renderService._renderer.value._glyphRenderer.value
      glyph._lastSeenPageLayoutVersion = 5
    })

    schedulePaneRevealPresent(() => [pane])
    flushSettledFrames()

    expect(mocks.resetAndRefreshAllTerminalWebglAtlases).not.toHaveBeenCalled()
  })

  it('ignores paused, hidden, DOM-only, or DEC 2026 synchronized-output panes', () => {
    expect(
      hasPaneWebglAtlasVersionDesync(
        makeFakePane({ atlasLayoutVersion: 4, glyphLayoutVersion: 1, isPaused: true })
      )
    ).toBe(false)
    expect(
      hasPaneWebglAtlasVersionDesync(
        makeFakePane({ atlasLayoutVersion: 4, glyphLayoutVersion: 1, displayNone: true })
      )
    ).toBe(false)
    expect(
      hasPaneWebglAtlasVersionDesync(
        makeFakePane({ atlasLayoutVersion: 4, glyphLayoutVersion: 1, webglAttached: false })
      )
    ).toBe(false)
    expect(
      hasPaneWebglAtlasVersionDesync(
        makeFakePane({ atlasLayoutVersion: 4, glyphLayoutVersion: 1, synchronizedOutput: true })
      )
    ).toBe(false)
  })
})
