import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NodeFileReadTooLargeError } from './node-bounded-file-reader'
import { JsonStringifyByteLimitError } from './node-bounded-json-stringify'
import {
  PersistedStateSecretCapacityError,
  assertPersistedStateSecretWithinLimit,
  readPersistedStateJsonFileSync,
  replacePersistedStateJsonWithinLimit,
  restorePersistedStateBackupSync,
  stringifyPrettyPersistedStateWithinLimit,
  stringifyPersistedStateWithinLimit,
  updatePersistedStateHashWithJsonRange
} from './persisted-state-file-bounds'

describe('persisted state file bounds', () => {
  let root = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-state-bounds-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('reads and parses a state file exactly at the byte limit', () => {
    const path = join(root, 'state.json')
    const json = `{"value":"${'x'.repeat(20)}"}`
    writeFileSync(path, json)

    expect(
      readPersistedStateJsonFileSync<{ value: string }>(path, Buffer.byteLength(json))
    ).toEqual({
      byteLength: Buffer.byteLength(json),
      value: { value: 'x'.repeat(20) }
    })
  })

  it('rejects an oversized sparse state file before reading its body', () => {
    const path = join(root, 'state.json')
    writeFileSync(path, '')
    truncateSync(path, 1025)

    expect(() => readPersistedStateJsonFileSync(path, 1024)).toThrow(NodeFileReadTooLargeError)
  })

  it('rejects structurally amplified state before parsing it', () => {
    const path = join(root, 'state.json')
    const json = '{"rows":[{},{}]}'
    writeFileSync(path, json)

    expect(() =>
      readPersistedStateJsonFileSync(path, Buffer.byteLength(json), {
        structuralTokens: 7,
        nestingDepth: 3
      })
    ).toThrow('JSON structure')
  })

  it('matches native compact JSON exactly at the output boundary', () => {
    const state = { quote: '"', unicode: '🐋', nested: [1, true, null] }
    const native = JSON.stringify(state)

    expect(stringifyPersistedStateWithinLimit(state, Buffer.byteLength(native))).toEqual({
      byteLength: Buffer.byteLength(native),
      serialized: native
    })
    expect(() => stringifyPersistedStateWithinLimit(state, Buffer.byteLength(native) - 1)).toThrow(
      JsonStringifyByteLimitError
    )
  })

  it('matches native pretty JSON and enforces its whitespace-inclusive boundary', () => {
    const state = { nested: { value: 'x' }, list: [1, 2] }
    const native = JSON.stringify(state, null, 2)

    expect(stringifyPrettyPersistedStateWithinLimit(state, Buffer.byteLength(native))).toEqual({
      byteLength: Buffer.byteLength(native),
      serialized: native
    })
    expect(() =>
      stringifyPrettyPersistedStateWithinLimit(state, Buffer.byteLength(native) - 1)
    ).toThrow(JsonStringifyByteLimitError)
  })

  it('bounds secret plaintext before encryption can expand it', () => {
    assertPersistedStateSecretWithinLimit('🐋', 4)

    expect(() => assertPersistedStateSecretWithinLimit('🐋x', 4)).toThrow(
      PersistedStateSecretCapacityError
    )
  })

  it('checks replacement growth before constructing the next payload', () => {
    const serialized = '{"value":"slot"}'
    const exactBytes =
      Buffer.byteLength(serialized) - Buffer.byteLength('slot') + Buffer.byteLength('expanded')

    expect(
      replacePersistedStateJsonWithinLimit({
        serialized,
        currentBytes: Buffer.byteLength(serialized),
        search: 'slot',
        replacement: 'expanded',
        maxBytes: exactBytes
      })
    ).toEqual({ byteLength: exactBytes, serialized: '{"value":"expanded"}' })
    expect(() =>
      replacePersistedStateJsonWithinLimit({
        serialized,
        currentBytes: Buffer.byteLength(serialized),
        search: 'slot',
        replacement: 'expanded',
        maxBytes: exactBytes - 1
      })
    ).toThrow(JsonStringifyByteLimitError)
  })

  it('hashes bounded string ranges without splitting UTF-16 surrogate pairs', () => {
    const value = `prefix-${'x'.repeat(8)}🐋-${'y'.repeat(8)}-suffix`
    const expected = createHash('sha1').update(value).digest('hex')
    const actual = createHash('sha1')

    updatePersistedStateHashWithJsonRange(actual, value, 0, value.length, 2)

    expect(actual.digest('hex')).toBe(expected)
  })

  it('atomically restores only a valid in-limit backup', () => {
    const backupPath = join(root, 'backup.json')
    const targetPath = join(root, 'profile', 'orca-data.json')
    writeFileSync(backupPath, '{"repos":[{"id":"recovered"}]}')

    restorePersistedStateBackupSync(backupPath, targetPath, 1024)

    expect(JSON.parse(readFileSync(targetPath, 'utf8'))).toEqual({
      repos: [{ id: 'recovered' }]
    })
    const originalTarget = readFileSync(targetPath)
    writeFileSync(backupPath, '{{invalid')
    expect(() => restorePersistedStateBackupSync(backupPath, targetPath, 1024)).toThrow()
    expect(readFileSync(targetPath)).toEqual(originalTarget)
    expect(
      readdirSync(join(root, 'profile')).filter((name) => name.endsWith('.recovery.tmp'))
    ).toEqual([])
  })

  it('leaves the target untouched when a backup exceeds the cap', () => {
    const backupPath = join(root, 'backup.json')
    const targetPath = join(root, 'orca-data.json')
    writeFileSync(targetPath, '{"original":true}')
    writeFileSync(backupPath, '')
    truncateSync(backupPath, 1025)

    expect(() => restorePersistedStateBackupSync(backupPath, targetPath, 1024)).toThrow(
      NodeFileReadTooLargeError
    )
    expect(readFileSync(targetPath, 'utf8')).toBe('{"original":true}')
  })
})
