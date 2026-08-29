import { constants as bufferConstants } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import {
  EDITOR_PREVIEWABLE_BINARY_MAX_BYTES,
  EDITOR_READ_OVERRIDE_CEILING_BYTES,
  EDITOR_TEXT_READ_LIMIT_BYTES,
  MONACO_HEAP_OPERATION_LIMIT_BYTES,
  formatFileTooLargeMessage,
  parseFileTooLargeMessage
} from './editor-file-read-limit'

describe('editor file read limits', () => {
  // Guards #1367 ("Allow large text files to open in editor") against a silent
  // revert: a later consistency pass must not quietly shrink the local budget.
  it('keeps the local text budget at 50MB', () => {
    expect(EDITOR_TEXT_READ_LIMIT_BYTES.local).toBe(50 * 1024 * 1024)
    expect(EDITOR_PREVIEWABLE_BINARY_MAX_BYTES).toBe(50 * 1024 * 1024)
  })

  it('keeps the lower SSH budget the transports actually enforce', () => {
    expect(EDITOR_TEXT_READ_LIMIT_BYTES.ssh).toBe(10 * 1024 * 1024)
  })

  // The override lifts the confirmation budget; it must still land under a
  // ceiling, or the read dies on an unparseable V8 allocation throw instead.
  it('keeps the override ceiling above every budget it lifts', () => {
    expect(EDITOR_READ_OVERRIDE_CEILING_BYTES).toBeGreaterThan(EDITOR_TEXT_READ_LIMIT_BYTES.local)
    expect(EDITOR_READ_OVERRIDE_CEILING_BYTES).toBeGreaterThan(EDITOR_PREVIEWABLE_BINARY_MAX_BYTES)
  })

  // Measured against the running V8, not a remembered number: the ceiling has to
  // hold for base64 too, which inflates 3 bytes into 4 string characters.
  it('keeps a ceiling-sized read representable as one string in this V8', () => {
    const base64Length = Math.ceil(EDITOR_READ_OVERRIDE_CEILING_BYTES / 3) * 4
    expect(base64Length).toBeLessThanOrEqual(bufferConstants.MAX_STRING_LENGTH)
    // utf-8 decoding never yields more UTF-16 code units than input bytes.
    expect(EDITOR_READ_OVERRIDE_CEILING_BYTES).toBeLessThanOrEqual(
      bufferConstants.MAX_STRING_LENGTH
    )
  })

  // Why: past this the editor's own model refuses every whole-buffer read
  // (mount-time content sync and save both take one), so admitting more bytes
  // buys a tab that throws instead of a tab that is merely slow.
  it('keeps the override ceiling under the editor model heap-operation limit', () => {
    expect(EDITOR_READ_OVERRIDE_CEILING_BYTES).toBeLessThanOrEqual(
      MONACO_HEAP_OPERATION_LIMIT_BYTES
    )
  })

  it('round-trips the too-large message through an IPC wrapper prefix', () => {
    const message = formatFileTooLargeMessage({
      byteLength: 53_477_376,
      limitBytes: EDITOR_TEXT_READ_LIMIT_BYTES.local,
      scope: 'local'
    })
    expect(message).toContain('51.0 MB')
    expect(message).toContain('50.0 MB')

    const wrapped = `Error invoking remote method 'fs:readFile': Error: ${message}`
    expect(parseFileTooLargeMessage(wrapped)).toEqual({
      byteLength: 53_477_376,
      limitBytes: 52_428_800,
      scope: 'local'
    })
  })

  // The editor's automatic backoff keys off this prefix; a size refusal is
  // deterministic, so retrying it just burns the budget.
  it('keeps the prefix the retry gate treats as terminal', () => {
    for (const scope of ['local', 'ssh', 'runtime'] as const) {
      expect(
        formatFileTooLargeMessage({ byteLength: 1, limitBytes: 1, scope }).toLowerCase()
      ).toContain('file too large')
    }
  })

  // Regression: Math.round(524288 / 1024 / 1024) labelled the 512KB runtime
  // budget "1MB", so the sentence claimed 0.5MB exceeded 1MB.
  it('labels a sub-megabyte limit in the unit it actually is', () => {
    const message = formatFileTooLargeMessage({
      byteLength: 524_289,
      limitBytes: 512 * 1024,
      scope: 'runtime'
    })
    expect(message).toContain('512.0 KB')
    expect(message).not.toContain('1MB')
    expect(message).not.toContain('1 MB')
  })

  // The runtime host only reads a bounded prefix, so it knows the budget but not
  // the file's size. Naming a size it never observed is the bug this guards.
  it('omits a size the caller could not observe', () => {
    const message = formatFileTooLargeMessage({ limitBytes: 512 * 1024, scope: 'runtime' })
    expect(message).not.toContain('exceeds')
    expect(message).toContain('512.0 KB')
    expect(parseFileTooLargeMessage(message)).toEqual({
      limitBytes: 524_288,
      scope: 'runtime'
    })
  })

  // SSH-backed runtime reads refuse with the bare protocol token, which carries
  // no numbers. It must still read as terminal, not as an unknown failure.
  it('recognizes the bare file_too_large protocol token', () => {
    expect(
      parseFileTooLargeMessage("Error invoking remote method 'files.read': Error: file_too_large")
    ).toEqual({})
    expect(parseFileTooLargeMessage('file_too_large_variant')).toBeNull()
  })

  it('names the transport so the fallback never claims one shared limit', () => {
    const ssh = formatFileTooLargeMessage({
      byteLength: 12_000_000,
      limitBytes: EDITOR_TEXT_READ_LIMIT_BYTES.ssh,
      scope: 'ssh'
    })
    expect(parseFileTooLargeMessage(ssh)?.scope).toBe('ssh')
    expect(parseFileTooLargeMessage('some unrelated read failure')).toBeNull()
  })
})
