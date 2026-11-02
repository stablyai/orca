import { expect, it } from 'vitest'
import { inlineImagePayload } from './helpers/terminal-inline-image-proof'

it.each([false, true])(
  'frames the RGB Kitty upload within protocol limits (placeholders: %s)',
  (placeholders) => {
    const payload = inlineImagePayload(placeholders)
    // oxlint-disable-next-line no-control-regex -- Parse the actual Kitty APC delimiters.
    const frames = [...payload.matchAll(/\x1b_G([^;]*);([^\x1b]*)\x1b\\/g)]
    const first = frames.findIndex((frame) => frame[1].split(',').includes('f=24'))
    expect(first).toBeGreaterThanOrEqual(0)
    const upload: string[] = []
    let nextOffset = frames[first].index
    let completed = false
    for (const frame of frames.slice(first)) {
      expect(frame.index).toBe(nextOffset)
      const fields = Object.fromEntries(frame[1].split(',').map((field) => field.split('=')))
      if (upload.length === 0) {
        expect(fields).toMatchObject({ a: 'T', f: '24', s: '120', v: '36', q: '2' })
      } else {
        expect(Object.keys(fields).sort()).toEqual(['m', 'q'])
        expect(fields.q).toBe('2')
      }
      expect(frame[2].length).toBeGreaterThan(0)
      expect(frame[2].length).toBeLessThanOrEqual(4096)
      expect(frame[2]).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
      upload.push(frame[2])
      nextOffset += frame[0].length
      if (fields.m === '0') {
        completed = true
        break
      }
      expect(fields.m).toBe('1')
      expect(frame[2].length % 4).toBe(0)
    }
    expect(completed).toBe(true)
    expect(Buffer.from(upload.join(''), 'base64')).toEqual(
      Buffer.alloc(120 * 36 * 3).fill(Buffer.from([40, 40, 240]))
    )
    expect(payload.slice(nextOffset)).toMatch(/^\r\n\r\n/)
  }
)
