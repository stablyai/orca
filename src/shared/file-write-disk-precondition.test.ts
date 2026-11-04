import { describe, expect, it } from 'vitest'
import {
  diskBaselineSignatureLength,
  getDiskBaselineSignature,
  utf8ByteSizeCanDecodeToLength
} from './disk-baseline-signature'
import {
  compareDiskWritePrecondition,
  diskConflictFromReadFailure,
  parseFileWriteResult
} from './file-write-disk-precondition'

describe('disk write precondition', () => {
  it('compares decoded disk text against the baseline signature', () => {
    const precondition = { expectedSignature: getDiskBaselineSignature('base') }
    expect(compareDiskWritePrecondition(precondition, 'base', 'mine')).toBeNull()
    expect(compareDiskWritePrecondition(precondition, 'newer', 'mine')).toBe('changed')
    expect(compareDiskWritePrecondition(precondition, undefined, 'mine')).toBe('changed')
    expect(compareDiskWritePrecondition(precondition, null, 'mine')).toBe('missing')
    expect(
      compareDiskWritePrecondition({ ...precondition, allowMissing: true }, null, 'mine')
    ).toBeNull()
  })

  it('accepts a changed disk that already holds exactly the text being saved', () => {
    const precondition = { expectedSignature: getDiskBaselineSignature('base') }
    expect(compareDiskWritePrecondition(precondition, 'mine', 'mine')).toBe('identical')
    expect(compareDiskWritePrecondition(precondition, 'base', 'base')).toBe('identical')
    expect(compareDiskWritePrecondition(precondition, 'mine\r\n', 'mine\n')).toBe('changed')
    expect(compareDiskWritePrecondition(precondition, undefined, 'mine')).toBe('changed')
    // A replacement character may stand for bytes the decode dropped, so it proves nothing.
    expect(compareDiskWritePrecondition(precondition, 'a�', 'a�')).toBe('changed')
  })

  it('refuses ambiguous automatic baseline matches but preserves explicit saves', () => {
    const decoded = Buffer.from([0x61, 0xfe]).toString('utf8')
    const current = Buffer.from([0x61, 0xff]).toString('utf8')
    const precondition = { expectedSignature: getDiskBaselineSignature(decoded) }
    expect(
      compareDiskWritePrecondition({ ...precondition, requireLosslessUtf8: true }, current, decoded)
    ).toBe('not-utf8')
    expect(compareDiskWritePrecondition(precondition, current, decoded)).toBeNull()
  })

  it('reports an external rewrite as changed before checking for U+FFFD', () => {
    expect(
      compareDiskWritePrecondition(
        { expectedSignature: getDiskBaselineSignature('original'), requireLosslessUtf8: true },
        'rewritten �',
        'mine'
      )
    ).toBe('changed')
  })

  it('treats anything but an explicit refusal from a host as a completed write', () => {
    expect(parseFileWriteResult({ ok: false, diskConflict: 'not-utf8' })).toEqual({
      ok: false,
      diskConflict: 'not-utf8'
    })
    expect(parseFileWriteResult({ ok: false, diskConflict: 'later' })).toEqual({
      ok: false,
      diskConflict: 'changed'
    })
    expect(parseFileWriteResult(undefined)).toEqual({ ok: true })
    expect(parseFileWriteResult({ ok: true })).toEqual({ ok: true })
    expect(parseFileWriteResult({ ok: true, unchanged: true })).toEqual({
      ok: true,
      unchanged: true
    })
    expect(parseFileWriteResult({ ok: false, diskConflict: 'missing' })).toEqual({
      ok: false,
      diskConflict: 'missing'
    })
    expect(parseFileWriteResult({ ok: false })).toEqual({ ok: false, diskConflict: 'changed' })
  })

  it('bounds the UTF-8 size a baseline can decode from', () => {
    const content = 'a€𝄞'
    const length = diskBaselineSignatureLength(getDiskBaselineSignature(content))
    expect(length).toBe(content.length)
    expect(utf8ByteSizeCanDecodeToLength(Buffer.byteLength(content), length ?? -1)).toBe(true)
    expect(utf8ByteSizeCanDecodeToLength(content.length - 1, content.length)).toBe(false)
    expect(utf8ByteSizeCanDecodeToLength(content.length * 3 + 1, content.length)).toBe(false)
    expect(diskBaselineSignatureLength('not-a-signature')).toBeNull()
  })

  it.each([
    [
      'an ENOENT code with plain wording',
      Object.assign(new Error('File not found'), { code: 'ENOENT' })
    ],
    ['an SFTP-style message', new Error('No such file or directory')]
  ])('treats %s from an older host as a missing file', (_label, error) => {
    const precondition = { expectedSignature: getDiskBaselineSignature('base') }
    expect(diskConflictFromReadFailure(precondition, error)).toBe('missing')
  })

  it.each([
    [
      'the desktop IPC wrapping',
      "Error invoking remote method 'fs:readFile': Error: ENOENT: no such file or directory, open '/repo/a.ts'"
    ],
    ['the runtime wording', "ENOENT: no such file or directory, stat '/repo/a.ts'"]
  ])('reads a not-found from %s', (_label, message) => {
    const precondition = { expectedSignature: getDiskBaselineSignature('base') }
    expect(diskConflictFromReadFailure(precondition, new Error(message))).toBe('missing')
  })

  it.each([
    "EACCES: permission denied, open '/repo/ENOENT.md'",
    "EACCES: permission denied, open '/repo/ENOENT/notes.md'",
    "EACCES: permission denied, open '/repo/No such file or directory/notes.md'",
    "EACCES: permission denied, open '/repo/Error: ENOENT: no such file or directory.txt'",
    "Error invoking remote method 'fs:readFile': Error: EACCES: permission denied, open '/repo/Error: ENOENT: no such file or directory.txt'"
  ])('never reads a path that merely names ENOENT as a missing file: %s', (message) => {
    const precondition = {
      expectedSignature: getDiskBaselineSignature('base'),
      allowMissing: true
    }
    expect(() => diskConflictFromReadFailure(precondition, new Error(message))).toThrow('EACCES')
  })

  it('trusts a conflicting errno code over not-found wording', () => {
    const error = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'EACCES' })
    expect(() =>
      diskConflictFromReadFailure({ expectedSignature: getDiskBaselineSignature('base') }, error)
    ).toThrow('ENOENT')
  })
})
