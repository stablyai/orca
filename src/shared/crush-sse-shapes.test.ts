import { describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import {
  crushHookEventName,
  crushHookPayload,
  crushOrcaHostUrl,
  crushOrcaSocketFileName,
  parseCrushSseChunk,
  parseCrushSseEvent
} from './crush-sse-shapes'

describe('crushOrcaSocketFileName', () => {
  it('sanitizes the launch token', () => {
    expect(crushOrcaSocketFileName('abc-123_XYZ')).toBe('crush-orca-abc-123_XYZ.sock')
  })

  it('strips filesystem-unsafe characters', () => {
    expect(crushOrcaSocketFileName('a/b:c')).toBe('crush-orca-abc.sock')
  })

  it('falls back when empty', () => {
    expect(crushOrcaSocketFileName('')).toBe('crush-orca-default.sock')
  })
})

describe('crushOrcaHostUrl', () => {
  it('builds a unix:// URL with a trailing-slash-stripped dir', () => {
    expect(crushOrcaHostUrl('/tmp', 'tok-id')).toBe('unix:///tmp/crush-orca-tok-id.sock')
    expect(crushOrcaHostUrl('/var/run/', 'tok-id')).toBe('unix:///var/run/crush-orca-tok-id.sock')
  })

  it('keeps the full path under sun_path even with a long tmpdir + UUID token', () => {
    // Why: a 60-char tmpdir + 36-char UUID token would be 60+1+52=113 (> macOS
    // sun_path 104). The hash fallback collapses the token to 12 hex chars
    // (60+1+28=89 ✓). Larger tmpdirs show up on some CI/dev sandboxes.
    const longDir = `/${'x'.repeat(59)}` // 60 chars
    const url = crushOrcaHostUrl(longDir, '550e8400-e29b-41d4-a716-446655440000')
    expect(url.startsWith('unix://')).toBe(true)
    const socketPath = url.slice('unix://'.length)
    expect(socketPath.length).toBeLessThanOrEqual(103)
    // Why: hashed filenames are deterministic — Orca's dial path must match the
    // path crush's auto-spawned server binds (both derive from the same launchToken).
    expect(crushOrcaHostUrl(longDir, '550e8400-e29b-41d4-a716-446655440000')).toBe(url)
    // Sanity: a short dir with the same token keeps the literal form (no hash).
    expect(crushOrcaHostUrl('/tmp', '550e8400-e29b-41d4-a716-446655440000')).toBe(
      'unix:///tmp/crush-orca-550e8400-e29b-41d4-a716-446655440000.sock'
    )
  })

  it('produces distinct hashed filenames for distinct tokens on a long dir', () => {
    const longDir = `/${'x'.repeat(59)}`
    const a = crushOrcaHostUrl(longDir, '550e8400-e29b-41d4-a716-446655440000')
    const b = crushOrcaHostUrl(longDir, '6ba7b810-9dad-11d1-80b4-00c04fd430c8')
    expect(a).not.toBe(b)
  })
})

describe('parseCrushSseChunk', () => {
  it('parses single-line data: payloads', () => {
    const { events, rest } = parseCrushSseChunk('', 'data: {"type":"run_complete"}\n\n')
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('{"type":"run_complete"}')
    expect(rest).toBe('')
  })

  it('parses multi-line data: payloads (joins with newline per SSE spec)', () => {
    const { events } = parseCrushSseChunk('', 'data: line-1\ndata: line-2\n\n')
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('line-1\nline-2')
  })

  it('strips a single leading space after `data:` per SSE spec', () => {
    const { events } = parseCrushSseChunk('', 'data: hello\n\n')
    expect(events[0].data).toBe('hello')
  })

  it('buffers an incomplete event across calls', () => {
    const first = parseCrushSseChunk('', 'data: not-yet')
    expect(first.events).toHaveLength(0)
    expect(first.rest).toBe('data: not-yet')
    const second = parseCrushSseChunk(first.rest, '-done\n\n')
    expect(second.events).toHaveLength(1)
    expect(second.events[0].data).toBe('not-yet-done')
    expect(second.rest).toBe('')
  })

  it('ignores comment/field lines that are not data:', () => {
    const { events } = parseCrushSseChunk('', ': ping\nevent: add\ndata: x\n\n')
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('x')
  })

  it('parses multiple events in one chunk', () => {
    const { events } = parseCrushSseChunk(
      '',
      'data: {"type":"message"}\n\ndata: {"type":"run_complete"}\n\n'
    )
    expect(events).toHaveLength(2)
    expect(events[0].data).toBe('{"type":"message"}')
    expect(events[1].data).toBe('{"type":"run_complete"}')
  })

  it('skips events with no data lines', () => {
    const { events } = parseCrushSseChunk('', 'event: noop\n\n')
    expect(events).toHaveLength(0)
  })

  it('parses CRLF-terminated events (\\r\\n\\r\\n separator)', () => {
    const { events, rest } = parseCrushSseChunk('', 'data: {"type":"run_complete"}\r\n\r\n')
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('{"type":"run_complete"}')
    expect(rest).toBe('')
  })

  it('parses CR-only-terminated events (\\r\\r separator)', () => {
    const { events, rest } = parseCrushSseChunk('', 'data: {"type":"message"}\r\r')
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('{"type":"message"}')
    expect(rest).toBe('')
  })

  it('parses mixed line endings within a single chunk', () => {
    const { events } = parseCrushSseChunk(
      '',
      'data: line-1\r\ndata: line-2\r\n\r\ndata: {"type":"done"}\n\n'
    )
    expect(events).toHaveLength(2)
    expect(events[0].data).toBe('line-1\nline-2')
    expect(events[1].data).toBe('{"type":"done"}')
  })
})

describe('parseCrushSseEvent', () => {
  it('returns null for malformed JSON', () => {
    expect(parseCrushSseEvent({ data: 'not-json' })).toBeNull()
  })

  it('parses a valid crush envelope', () => {
    const ev = parseCrushSseEvent({
      data: '{"type":"run_complete","payload":{"type":"updated","payload":{"session_id":"s1"}}}'
    })
    expect(ev?.type).toBe('run_complete')
  })
})

describe('crushHookEventName', () => {
  it('splits message by role', () => {
    expect(crushHookEventName({ type: 'message', payload: { payload: { role: 'user' } } })).toBe(
      'message:user'
    )
    expect(
      crushHookEventName({ type: 'message', payload: { payload: { role: 'assistant' } } })
    ).toBe('message:assistant')
    expect(crushHookEventName({ type: 'message', payload: { payload: { role: 'tool' } } })).toBe(
      'message'
    )
  })

  it('returns the SSE type for non-message envelopes', () => {
    expect(crushHookEventName({ type: 'run_complete' })).toBe('run_complete')
    expect(crushHookEventName({ type: 'permission_request' })).toBe('permission_request')
    expect(crushHookEventName({ type: 'agent_event' })).toBe('agent_event')
  })

  it('returns null for unhandled types', () => {
    expect(crushHookEventName({ type: 'session' })).toBeNull()
  })
})

describe('crushHookPayload', () => {
  it('extracts the inner payload', () => {
    expect(
      crushHookPayload({
        type: 'run_complete',
        payload: { payload: { session_id: 's1', text: 'hi' } }
      })
    ).toEqual({ session_id: 's1', text: 'hi' })
  })

  it('returns empty record when inner payload is missing', () => {
    expect(crushHookPayload({ type: 'run_complete' })).toEqual({})
  })
})

// Why: ensure vi is referenced so type-only imports don't trip tree-shake warnings.
describe('vitest wiring sanity', () => {
  it('exposes vi', () => {
    expect(vi.fn).toBeDefined()
  })
})
