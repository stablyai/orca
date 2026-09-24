import { describe, expect, it } from 'vitest'
import { createLspFrameParser, encodeLspMessage } from './lsp-content-length-framer'

function collect(sink: unknown[]): {
  feed: (chunk: Buffer) => void
  errors: Error[]
} {
  const errors: Error[] = []
  const parser = createLspFrameParser(
    (message) => sink.push(message),
    (error) => errors.push(error)
  )
  return { feed: (chunk: Buffer) => parser.feed(chunk), errors }
}

describe('encodeLspMessage', () => {
  it('produces a Content-Length header matching the utf-8 body length', () => {
    const bytes = encodeLspMessage({ jsonrpc: '2.0', method: 'x', params: { 中文: 'é' } })
    const headerEnd = bytes.indexOf('\r\n\r\n')
    expect(headerEnd).toBeGreaterThan(0)
    const header = bytes.subarray(0, headerEnd).toString('ascii')
    const body = bytes.subarray(headerEnd + 4)
    expect(header).toBe(`Content-Length: ${body.length}`)
    expect(JSON.parse(body.toString('utf8'))).toEqual({
      jsonrpc: '2.0',
      method: 'x',
      params: { 中文: 'é' }
    })
  })
})

describe('createLspFrameParser', () => {
  it('parses one complete frame', () => {
    const sink: unknown[] = []
    const { feed, errors } = collect(sink)
    feed(encodeLspMessage({ id: 1, result: null }))
    expect(sink).toEqual([{ id: 1, result: null }])
    expect(errors).toEqual([])
  })

  it('handles multiple frames in one chunk (sticky packets)', () => {
    const sink: unknown[] = []
    const { feed } = collect(sink)
    feed(
      Buffer.concat([
        encodeLspMessage({ method: 'a' }),
        encodeLspMessage({ method: 'b' }),
        encodeLspMessage({ method: 'c' })
      ])
    )
    expect(sink.map((m) => (m as { method: string }).method)).toEqual(['a', 'b', 'c'])
  })

  it('reassembles frames split across chunks at any byte boundary', () => {
    const sink: unknown[] = []
    const { feed } = collect(sink)
    const wire = Buffer.concat([
      encodeLspMessage({ method: 'split', params: { text: '多字节𐍈内容' } }),
      encodeLspMessage({ method: 'next' })
    ])
    // Feed one byte at a time: header/body boundaries and multi-byte UTF-8
    // sequences all get split somewhere in this walk.
    for (let i = 0; i < wire.length; i += 1) {
      feed(wire.subarray(i, i + 1))
    }
    expect(sink).toEqual([{ method: 'split', params: { text: '多字节𐍈内容' } }, { method: 'next' }])
  })

  it('accepts the bare-LF header terminator defensively', () => {
    const sink: unknown[] = []
    const { feed, errors } = collect(sink)
    const body = Buffer.from('{"method":"lf"}', 'utf8')
    feed(Buffer.from(`Content-Length: ${body.length}\n\n`, 'ascii'))
    feed(body)
    expect(sink).toEqual([{ method: 'lf' }])
    expect(errors).toEqual([])
  })

  it('skips a Content-Type header line before Content-Length', () => {
    const sink: unknown[] = []
    const { feed, errors } = collect(sink)
    const body = Buffer.from('{"ok":true}', 'utf8')
    feed(
      Buffer.concat([
        Buffer.from(
          `Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: ${body.length}\r\n\r\n`,
          'ascii'
        ),
        body
      ])
    )
    expect(sink).toEqual([{ ok: true }])
    expect(errors).toEqual([])
  })

  it('kills the buffer on an unparsable Content-Length', () => {
    const sink: unknown[] = []
    const { feed, errors } = collect(sink)
    feed(Buffer.from('Content-Length: banana\r\n\r\n{"method":"x"}', 'ascii'))
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('Content-Length')
    // Buffer dropped: a follow-up good frame is not resurrected from garbage.
    expect(sink).toEqual([])
    feed(encodeLspMessage({ method: 'fresh' }))
    expect(sink).toEqual([{ method: 'fresh' }])
  })

  it('reports a JSON body failure instead of throwing mid-feed', () => {
    const sink: unknown[] = []
    const { feed, errors } = collect(sink)
    const bad = Buffer.from('{not json', 'utf8')
    feed(Buffer.concat([Buffer.from(`Content-Length: ${bad.length}\r\n\r\n`, 'ascii'), bad]))
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('JSON.parse')
    expect(sink).toEqual([])
  })

  it('treats a header block over 1MiB without a terminator as garbage', () => {
    const sink: unknown[] = []
    const { feed, errors } = collect(sink)
    feed(Buffer.alloc((1 << 20) + 1, 0x61))
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('exceeded')
    expect(sink).toEqual([])
  })

  it('waits for the full body before dispatching (half-open frame)', () => {
    const sink: unknown[] = []
    const { feed } = collect(sink)
    const bytes = encodeLspMessage({ method: 'pending' })
    feed(bytes.subarray(0, -2))
    expect(sink).toEqual([])
    feed(bytes.subarray(-2))
    expect(sink).toHaveLength(1)
  })
})
