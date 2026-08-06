import { describe, expect, it, vi } from 'vitest'
import { writeForegroundTerminalChunk } from './pane-terminal-foreground-render-settle'

type RefreshFn = (start: number, end: number, sync?: boolean) => void

type RenderServiceStub = {
  _isPaused: boolean
  _needsFullRefresh: boolean
  refreshRows: ReturnType<typeof vi.fn<RefreshFn>>
}

function createTerminal(paused: boolean): {
  terminal: {
    rows: number
    buffer: { active: { cursorY: number; baseY: number; viewportY: number } }
    _core: { refresh: ReturnType<typeof vi.fn<RefreshFn>>; _renderService: RenderServiceStub }
    refresh: ReturnType<typeof vi.fn<(start: number, end: number) => void>>
    write: (data: string, callback?: () => void) => void
  }
  renderService: RenderServiceStub
} {
  const renderService: RenderServiceStub = {
    _isPaused: paused,
    _needsFullRefresh: paused,
    refreshRows: vi.fn<RefreshFn>()
  }
  const terminal = {
    rows: 24,
    buffer: { active: { cursorY: 0, baseY: 0, viewportY: 0 } },
    _core: { refresh: vi.fn<RefreshFn>(), _renderService: renderService },
    refresh: vi.fn<(start: number, end: number) => void>(),
    write: (_data: string, callback?: () => void) => callback?.()
  }
  return { terminal, renderService }
}

describe('writeForegroundTerminalChunk render-pause ownership', () => {
  it('drives a paused render only for a currently visible reveal replay', () => {
    const { terminal, renderService } = createTerminal(true)

    writeForegroundTerminalChunk(terminal, 'replayed snapshot bytes', {
      forceViewportRefresh: true,
      shouldReleaseRenderPause: () => true
    })

    expect(renderService.refreshRows).toHaveBeenCalledWith(0, 23, true)
    expect(renderService._isPaused).toBe(false)
    expect(renderService._needsFullRefresh).toBe(false)
  })

  it('leaves a newly-hidden terminal paused when replay parsing finishes', () => {
    const { terminal, renderService } = createTerminal(true)
    let parsed: (() => void) | undefined
    let visible = true
    terminal.write = (_data: string, callback?: () => void) => {
      parsed = callback
    }

    writeForegroundTerminalChunk(terminal, 'late replay bytes', {
      forceViewportRefresh: true,
      shouldReleaseRenderPause: () => visible
    })
    visible = false
    parsed?.()

    expect(renderService.refreshRows).not.toHaveBeenCalled()
    expect(renderService._isPaused).toBe(true)
    expect(renderService._needsFullRefresh).toBe(true)
  })

  it('does not inspect RenderService on the ordinary forced-refresh path', () => {
    const { terminal, renderService } = createTerminal(true)
    const renderServiceRead = vi.fn(() => renderService)
    Object.defineProperty(terminal._core, '_renderService', { get: renderServiceRead })

    writeForegroundTerminalChunk(terminal, 'ordinary output', {
      forceViewportRefresh: true
    })

    expect(renderServiceRead).not.toHaveBeenCalled()
    expect(terminal._core.refresh).toHaveBeenCalledWith(0, 23, true)
  })
})
