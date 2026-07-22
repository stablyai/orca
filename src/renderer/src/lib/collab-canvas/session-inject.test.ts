import { describe, expect, it, vi } from 'vitest'
import { buildCollabCanvasInjectPayload } from './collab-canvas-bridge'
import { injectCollabPayloadIntoTerminal, injectSessionBoardAwareness } from './session-inject'
import { PASTE_TERMINAL_TEXT_EVENT } from '@/constants/terminal'

describe('injectCollabPayloadIntoTerminal', () => {
  it('dispatches paste with terminal tabId (existing session agent path)', () => {
    const payload = buildCollabCanvasInjectPayload({
      boardId: 'b1',
      worktreeId: 'wt-1',
      textDigest: 'circle the bug',
      atlasDataUri: null,
      bounds: null,
      selectedShapeIds: ['s1']
    })
    const dispatch = vi.fn()
    const result = injectCollabPayloadIntoTerminal(payload, {
      tabId: 'term-tab-1',
      dispatch
    })
    expect(result).toEqual({
      ok: true,
      usesExistingSessionAgent: true,
      tabId: 'term-tab-1'
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
    const ev = dispatch.mock.calls[0][0] as CustomEvent
    expect(ev.type).toBe(PASTE_TERMINAL_TEXT_EVENT)
    expect(ev.detail.tabId).toBe('term-tab-1')
    expect(ev.detail.worktreeId).toBe('wt-1')
    expect(ev.detail.text).toContain('circle the bug')
  })

  it('refuses empty tabId', () => {
    const payload = buildCollabCanvasInjectPayload({
      boardId: 'b1',
      worktreeId: 'wt-1',
      textDigest: 'x',
      atlasDataUri: null,
      bounds: null,
      selectedShapeIds: []
    })
    const result = injectCollabPayloadIntoTerminal(payload, {
      tabId: '  ',
      dispatch: vi.fn()
    })
    expect(result).toEqual({ ok: false, reason: 'missing-terminal-tab' })
  })
})

describe('injectSessionBoardAwareness', () => {
  it('pastes awareness text into the session terminal', () => {
    const dispatch = vi.fn()
    const result = injectSessionBoardAwareness({
      boardId: 'board-a',
      worktreeId: 'wt-1',
      tabId: 'term-1',
      dispatch
    })
    expect(result.ok).toBe(true)
    const ev = dispatch.mock.calls[0][0] as CustomEvent
    expect(ev.type).toBe(PASTE_TERMINAL_TEXT_EVENT)
    expect(ev.detail.tabId).toBe('term-1')
    expect(ev.detail.text).toContain('OPERATOR — collab board is open')
    expect(ev.detail.text).toContain('board-a')
    expect(ev.detail.text).toContain('no second agent')
  })
})
