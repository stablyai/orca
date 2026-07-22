import { describe, expect, it, vi } from 'vitest'
import { buildCollabCanvasInjectPayload } from './collab-canvas-bridge'
import { injectCollabPayloadIntoTerminal } from './session-inject'
import { PASTE_TERMINAL_TEXT_EVENT } from '@/constants/terminal'

describe('injectCollabPayloadIntoTerminal', () => {
  it('dispatches paste to the existing session agent path', () => {
    const payload = buildCollabCanvasInjectPayload({
      boardId: 'b1',
      worktreeId: 'wt-1',
      textDigest: 'circle the bug',
      atlasDataUri: null,
      bounds: null,
      selectedShapeIds: ['s1']
    })
    const dispatch = vi.fn()
    const result = injectCollabPayloadIntoTerminal(payload, dispatch)
    expect(result).toEqual({ ok: true, usesExistingSessionAgent: true })
    expect(dispatch).toHaveBeenCalledTimes(1)
    const ev = dispatch.mock.calls[0][0] as CustomEvent
    expect(ev.type).toBe(PASTE_TERMINAL_TEXT_EVENT)
    expect(ev.detail.worktreeId).toBe('wt-1')
    expect(ev.detail.text).toContain('circle the bug')
  })
})
