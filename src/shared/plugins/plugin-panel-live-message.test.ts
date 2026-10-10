import { describe, expect, it } from 'vitest'
import {
  normalizePanelLiveMessage,
  PANEL_LIVE_MESSAGE_MAX_BYTES,
  panelLiveMessageSchema,
  readPanelLiveMessageFrame
} from './plugin-panel-live-message'

describe('normalizePanelLiveMessage', () => {
  it('returns a detached JSON copy', () => {
    const value = { ticks: 3, nested: { list: [1, 'two', null, true] } }
    const result = normalizePanelLiveMessage(value)
    expect(result).toEqual({ ok: true, message: value })
    expect(result.ok && result.message).not.toBe(value)
  })

  it('applies JSON semantics to structured-clone-only values', () => {
    expect(normalizePanelLiveMessage({ at: new Date(0), missing: undefined })).toEqual({
      ok: true,
      message: { at: '1970-01-01T00:00:00.000Z' }
    })
  })

  it.each([
    ['undefined', undefined],
    ['a function', () => 1],
    ['a bigint', 1n],
    ['a class instance', new (class Point {})()]
  ])('rejects %s', (_label, value) => {
    expect(normalizePanelLiveMessage(value).ok).toBe(false)
  })

  it('rejects cycles without overflowing the stack', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(normalizePanelLiveMessage(cyclic)).toEqual({
      ok: false,
      error: 'panel message must be JSON-serializable'
    })
  })

  it('rejects messages over the size cap', () => {
    expect(normalizePanelLiveMessage('x'.repeat(PANEL_LIVE_MESSAGE_MAX_BYTES + 1))).toEqual({
      ok: false,
      error: 'panel message exceeds the size limit'
    })
  })

  it('surfaces refusals as schema issues for the host API table', () => {
    expect(panelLiveMessageSchema.safeParse(() => 1).success).toBe(false)
    expect(panelLiveMessageSchema.parse({ a: 1 })).toEqual({ a: 1 })
  })
})

describe('readPanelLiveMessageFrame', () => {
  it('matches only live-message frames', () => {
    expect(readPanelLiveMessageFrame({ type: 'orca-panel-message', message: { a: 1 } })).toEqual({
      matched: true,
      message: { a: 1 }
    })
    expect(readPanelLiveMessageFrame({ type: 'orca-panel-action', message: 1 })).toEqual({
      matched: false
    })
    expect(readPanelLiveMessageFrame('orca-panel-message')).toEqual({ matched: false })
    expect(readPanelLiveMessageFrame(null)).toEqual({ matched: false })
  })
})
