/**
 * STA-2694: an alt-screen agent TUI (OpenCode/OpenTUI, Codex, grok) brackets
 * every repaint in `?2026h … ?2026l`. Hiding the pane mid-bracket latches
 * xterm's synchronizedOutput mode, and RenderService.refreshRows checks that
 * latch BEFORE rendering — so on reveal the whole repaint arsenal renders zero
 * rows and the canvas keeps compositing pre-hide pixels.
 *
 * These tests drive the real reveal entry points against a terminal double that
 * mirrors xterm's gate order, so a regression that stops releasing the latch
 * shows up as "reveal repainted nothing".
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { schedulePaneRevealPresent } from './pane-reveal-repaint'
import { resetWebglTextureAtlas } from './pane-webgl-renderer'
import type { ManagedPaneInternal } from './pane-manager-types'

type GateState = { synchronizedOutput: boolean; rendered: number }

// Mirrors RenderService.refreshRows: paused first, then the synchronized-output
// buffer gate, then the actual render. This double can drift from xterm on an
// upgrade, so the gate order it encodes is independently pinned against the real
// renderer in tests/e2e/terminal-reveal-draw-command-probe.spec.ts.
function createGatedPane(options: { synchronizedOutput: boolean }): {
  pane: ManagedPaneInternal
  gate: GateState
} {
  const gate: GateState = { synchronizedOutput: options.synchronizedOutput, rendered: 0 }
  const refreshRows = (): void => {
    if (gate.synchronizedOutput) {
      return
    }
    gate.rendered += 1
  }
  const terminal = {
    rows: 24,
    cols: 80,
    refresh: refreshRows,
    _core: {
      coreService: {
        get decPrivateModes() {
          return gate
        }
      },
      _renderService: {
        _isPaused: false,
        _needsFullRefresh: false,
        refreshRows,
        _syncOutputHandler: { flush: vi.fn() }
      }
    }
  }
  const pane = {
    id: 1,
    terminal,
    gpuRenderingEnabled: false,
    webglAddon: null,
    webglAttachmentDeferred: false,
    webglDisabledAfterContextLoss: false
  } as unknown as ManagedPaneInternal
  return { pane, gate }
}

describe('reveal repaint under an abandoned synchronized-output frame', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('atlas-reset recovery repaints a pane hidden mid-synchronized-frame', () => {
    const { pane, gate } = createGatedPane({ synchronizedOutput: true })

    resetWebglTextureAtlas(pane)

    expect(gate.synchronizedOutput, 'the abandoned frame must be released').toBe(false)
    expect(gate.rendered, 'reveal must actually repaint, not buffer').toBeGreaterThan(0)
  })

  it('atlas-preserving present repaints a pane hidden mid-synchronized-frame', () => {
    const { pane, gate } = createGatedPane({ synchronizedOutput: true })

    schedulePaneRevealPresent(() => [pane])

    expect(gate.synchronizedOutput).toBe(false)
    expect(gate.rendered).toBeGreaterThan(0)
  })

  it('leaves a pane that was not mid-frame exactly as before', () => {
    const { pane, gate } = createGatedPane({ synchronizedOutput: false })

    resetWebglTextureAtlas(pane)

    expect(gate.synchronizedOutput).toBe(false)
    expect(gate.rendered).toBeGreaterThan(0)
  })
})
