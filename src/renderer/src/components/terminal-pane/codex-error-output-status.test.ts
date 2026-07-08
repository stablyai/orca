import { describe, expect, it, vi } from 'vitest'
import { createCodexErrorOutputStatusDetector } from './codex-error-output-status'

describe('Codex error output status detector', () => {
  it('detects stream-disconnect errors from Codex output', () => {
    const onStreamError = vi.fn()
    const detector = createCodexErrorOutputStatusDetector({ onStreamError })

    const observed = detector.observe(
      '■ stream disconnected before completion: error sending request for url (http://openclaw:2455/backend-api/codex/responses)\r\n'
    )

    expect(observed).toBe(true)
    expect(onStreamError).toHaveBeenCalledWith(
      'stream disconnected before completion: error sending request for url (http://openclaw:2455/backend-api/codex/responses)'
    )
  })

  it('detects a stream-disconnect error split across chunks', () => {
    const onStreamError = vi.fn()
    const detector = createCodexErrorOutputStatusDetector({ onStreamError })

    expect(detector.observe('■ stream discon')).toBe(false)
    expect(
      detector.observe(
        'nected before completion: error sending request for url (http://openclaw:2455/backend-api/codex/responses)\r\n'
      )
    ).toBe(true)

    expect(onStreamError).toHaveBeenCalledWith(
      'stream disconnected before completion: error sending request for url (http://openclaw:2455/backend-api/codex/responses)'
    )
  })

  it('waits for the full line when the stream-disconnect error splits after the colon', () => {
    const onStreamError = vi.fn()
    const detector = createCodexErrorOutputStatusDetector({ onStreamError })

    expect(detector.observe('■ stream disconnected before completion:')).toBe(false)
    expect(onStreamError).not.toHaveBeenCalled()

    expect(
      detector.observe(
        ' error sending request for url (http://openclaw:2455/backend-api/codex/responses)\r\n'
      )
    ).toBe(true)

    expect(onStreamError).toHaveBeenCalledTimes(1)
    expect(onStreamError).toHaveBeenCalledWith(
      'stream disconnected before completion: error sending request for url (http://openclaw:2455/backend-api/codex/responses)'
    )
  })

  it('detects a stream-disconnect error in the middle of a large PTY chunk', () => {
    const onStreamError = vi.fn()
    const detector = createCodexErrorOutputStatusDetector({ onStreamError })
    const chunk =
      `${'a'.repeat(8_000)}\r\n` +
      '■ stream disconnected before completion: context window exceeded\r\n' +
      `${'b'.repeat(8_000)}\r\n`

    expect(detector.observe(chunk)).toBe(true)

    expect(onStreamError).toHaveBeenCalledWith(
      'stream disconnected before completion: context window exceeded'
    )
  })

  it('does not complete transient Codex retry notices', () => {
    const onStreamError = vi.fn()
    const detector = createCodexErrorOutputStatusDetector({ onStreamError })

    expect(
      detector.observe(
        'stream error: stream disconnected before completion: temporary network failure; retrying 1/5 in 217ms\r\n'
      )
    ).toBe(false)
    expect(
      detector.observe(
        'stream disconnected before completion: temporary network failure; retrying 2/5 in 431ms\r\n'
      )
    ).toBe(false)

    expect(onStreamError).not.toHaveBeenCalled()
  })

  it('keeps the lowercase Codex fatal marker invariant', () => {
    const onStreamError = vi.fn()
    const detector = createCodexErrorOutputStatusDetector({ onStreamError })

    expect(
      detector.observe('Stream disconnected before completion: status panel repaint\r\n')
    ).toBe(false)

    expect(onStreamError).not.toHaveBeenCalled()
  })

  it('does not complete quoted or grepped stream-disconnect text', () => {
    const onStreamError = vi.fn()
    const detector = createCodexErrorOutputStatusDetector({ onStreamError })

    expect(
      detector.observe(
        'log.txt: stream disconnected before completion: old error from an earlier turn\r\n'
      )
    ).toBe(false)
    expect(
      detector.observe(
        '"stream disconnected before completion: old error from an earlier turn"\r\n'
      )
    ).toBe(false)

    expect(onStreamError).not.toHaveBeenCalled()
  })

  it('strips terminal control sequences before reporting the error message', () => {
    const onStreamError = vi.fn()
    const detector = createCodexErrorOutputStatusDetector({ onStreamError })

    detector.observe(
      '\x1b[31mstream disconnected before completion: error sending request for url (http://openclaw:2455/backend-api/codex/responses)\x1b[0m\r\n'
    )

    expect(onStreamError).toHaveBeenCalledWith(
      'stream disconnected before completion: error sending request for url (http://openclaw:2455/backend-api/codex/responses)'
    )
  })

  it('does not fire when a quoted marker is split right at the chunk seam', () => {
    const onStreamError = vi.fn()
    const detector = createCodexErrorOutputStatusDetector({ onStreamError })

    expect(detector.observe('The log said "')).toBe(false)
    expect(
      detector.observe('stream disconnected before completion: boom" and then it retried fine\r\n')
    ).toBe(false)

    expect(onStreamError).not.toHaveBeenCalled()
  })

  it('does not fire when a log-prefixed marker is split right at the chunk seam', () => {
    const onStreamError = vi.fn()
    const detector = createCodexErrorOutputStatusDetector({ onStreamError })

    expect(detector.observe('2026-07-03 ERROR ')).toBe(false)
    expect(
      detector.observe('stream disconnected before completion: old failure from a log\r\n')
    ).toBe(false)

    expect(onStreamError).not.toHaveBeenCalled()
  })

  it('fires when the fatal glyph arrived in an earlier chunk than the marker', () => {
    const onStreamError = vi.fn()
    const detector = createCodexErrorOutputStatusDetector({ onStreamError })

    expect(detector.observe('some earlier output\r\n■ ')).toBe(false)
    expect(
      detector.observe('stream disconnected before completion: context window exceeded\r\n')
    ).toBe(true)

    expect(onStreamError).toHaveBeenCalledWith(
      'stream disconnected before completion: context window exceeded'
    )
  })

  it('detects a fatal line that follows a rejected retry tail in the same chunk', () => {
    const onStreamError = vi.fn()
    const detector = createCodexErrorOutputStatusDetector({ onStreamError })

    expect(detector.observe('stream disconnected before completion: The server had an error')).toBe(
      false
    )
    expect(
      detector.observe(
        '; retrying 1/5 in 211ms\r\n■ stream disconnected before completion: fatal: exceeded retry limit\r\n'
      )
    ).toBe(true)

    expect(onStreamError).toHaveBeenCalledTimes(1)
    expect(onStreamError).toHaveBeenCalledWith(
      'stream disconnected before completion: fatal: exceeded retry limit'
    )
  })

  it('does not complete indented or echo-chrome occurrences of the error text', () => {
    const onStreamError = vi.fn()
    const detector = createCodexErrorOutputStatusDetector({ onStreamError })

    expect(
      detector.observe('  └ stream disconnected before completion: old error from a tool run\r\n')
    ).toBe(false)
    expect(
      detector.observe('    stream disconnected before completion: old error continuation\r\n')
    ).toBe(false)
    expect(
      detector.observe('› stream disconnected before completion: old error in a queued prompt\r\n')
    ).toBe(false)

    expect(onStreamError).not.toHaveBeenCalled()
  })

  it('drops a pending unterminated line on reset', () => {
    const onStreamError = vi.fn()
    const detector = createCodexErrorOutputStatusDetector({ onStreamError })

    expect(detector.observe('■ stream disconnected before completion:')).toBe(false)
    detector.reset()
    expect(detector.observe(' error tail from a different turn\r\n')).toBe(false)

    expect(onStreamError).not.toHaveBeenCalled()
  })
})
