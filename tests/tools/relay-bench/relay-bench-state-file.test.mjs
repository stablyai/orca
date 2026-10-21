// Why: the bench state file holds a live resume token and device token for a real paired desktop.
// A plain writeFileSync with `mode` leaves an existing 0644 file world-readable, follows a symlink
// into someone else's tree, and throws ENOENT on the default path after the desktop has already
// burned the provision request, losing the credential.
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSecretFile, writeSecretFile } from './relay-bench-state-file.mjs'

const posix = process.platform !== 'win32'
let dir

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relay-bench-state-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const modeOf = (path) => lstatSync(path).mode & 0o777

describe('writeSecretFile', () => {
  it('creates a missing parent directory instead of throwing ENOENT', () => {
    const path = join(dir, 'nested', 'deeper', 'state.json')
    writeSecretFile(path, '{"resumeToken":"secret"}')
    expect(readFileSync(path, 'utf8')).toBe('{"resumeToken":"secret"}')
  })

  it.runIf(posix)('forces 0600 on a file that already exists as 0644', () => {
    const path = join(dir, 'state.json')
    writeFileSync(path, 'old')
    chmodSync(path, 0o644)
    writeSecretFile(path, 'new')
    expect(modeOf(path)).toBe(0o600)
    expect(readFileSync(path, 'utf8')).toBe('new')
  })

  it.runIf(posix)('creates the file as 0600', () => {
    const path = join(dir, 'state.json')
    writeSecretFile(path, 'new')
    expect(modeOf(path)).toBe(0o600)
  })

  it.runIf(posix)('refuses to follow a symlink and leaves the target untouched', () => {
    const target = join(dir, 'target.json')
    const link = join(dir, 'state.json')
    writeFileSync(target, 'target contents')
    symlinkSync(target, link)
    expect(() => writeSecretFile(link, 'secret')).toThrow(/symlink/)
    expect(readFileSync(target, 'utf8')).toBe('target contents')
  })

  it('truncates rather than appending to a longer previous file', () => {
    const path = join(dir, 'state.json')
    writeSecretFile(path, '{"a":"aaaaaaaaaaaaaaaaaaaa"}')
    writeSecretFile(path, '{"b":1}')
    expect(readFileSync(path, 'utf8')).toBe('{"b":1}')
  })
})

describe('readSecretFile', () => {
  it('reads a file it wrote', () => {
    const path = join(dir, 'state.json')
    writeSecretFile(path, '{"resumeToken":"secret"}')
    expect(readSecretFile(path)).toBe('{"resumeToken":"secret"}')
  })

  it.runIf(posix)('refuses a state file other users can read', () => {
    const path = join(dir, 'state.json')
    writeFileSync(path, 'secret')
    chmodSync(path, 0o644)
    expect(() => readSecretFile(path)).toThrow(/chmod 600/)
  })

  it.runIf(posix)('refuses to read through a symlink', () => {
    const target = join(dir, 'target.json')
    const link = join(dir, 'state.json')
    writeFileSync(target, 'secret')
    chmodSync(target, 0o600)
    symlinkSync(target, link)
    expect(() => readSecretFile(link)).toThrow(/symlink/)
  })

  it('reports a missing file rather than returning empty text', () => {
    const path = join(dir, 'absent.json')
    expect(existsSync(path)).toBe(false)
    expect(() => readSecretFile(path)).toThrow(/ENOENT/)
  })
})
