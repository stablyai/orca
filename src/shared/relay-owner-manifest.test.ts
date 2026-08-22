import { describe, expect, it } from 'vitest'
import {
  RELAY_OWNER_MANIFEST_MAX_BYTES,
  isRelayGenerationToken,
  isRelayNamedPipeEndpoint,
  parseRelayOwnerManifest,
  relayOwnerManifestPath,
  serializeRelayOwnerManifest,
  type RelayOwnerManifest
} from './relay-owner-manifest'

const MANIFEST: RelayOwnerManifest = {
  generation: 'a'.repeat(64),
  pid: 4321,
  socketPath: '/home/user/.orca-remote/relay-0.1.0/relay-deadbeefdeadbeef.sock',
  socketDev: 16777232,
  socketIno: 987654321,
  socketCtimeSeconds: 1785948267
}

describe('relayOwnerManifestPath', () => {
  it('places the manifest adjacent to the socket', () => {
    expect(relayOwnerManifestPath('/tmp/x/relay-abc.sock')).toBe('/tmp/x/relay-abc.sock.owner')
  })
})

describe('isRelayNamedPipeEndpoint', () => {
  it.each([
    ['\\\\.\\pipe\\orca-relay-abc'],
    ['\\\\?\\pipe\\orca-relay-abc'],
    ['\\\\.\\PIPE\\orca-relay-abc']
  ])('recognises %s', (path) => {
    expect(isRelayNamedPipeEndpoint(path)).toBe(true)
  })

  it.each([
    ['a POSIX socket path', '/var/run/relay.sock'],
    ['a UNC share', '\\\\server\\share\\relay.sock'],
    ['a pipe-like prefix only', '\\\\.\\PIPEX\\relay'],
    ['an empty string', '']
  ])('rejects %s', (_label, path) => {
    expect(isRelayNamedPipeEndpoint(path)).toBe(false)
  })
})

describe('isRelayGenerationToken', () => {
  it('accepts exactly 64 lowercase hex characters', () => {
    expect(isRelayGenerationToken('f'.repeat(64))).toBe(true)
  })

  it.each([
    ['too short', 'a'.repeat(63)],
    ['too long', 'a'.repeat(65)],
    ['uppercase', 'A'.repeat(64)],
    ['non-hex', `${'a'.repeat(63)}z`],
    ['empty', ''],
    ['shell metacharacter', `${'a'.repeat(62)};$`],
    ['leading dash', `-${'a'.repeat(63)}`]
  ])('rejects %s', (_label, token) => {
    expect(isRelayGenerationToken(token)).toBe(false)
  })
})

describe('serializeRelayOwnerManifest / parseRelayOwnerManifest', () => {
  it('round-trips a manifest', () => {
    expect(parseRelayOwnerManifest(serializeRelayOwnerManifest(MANIFEST))).toEqual(MANIFEST)
  })

  it('stays far below the bounded read size', () => {
    expect(Buffer.byteLength(serializeRelayOwnerManifest(MANIFEST), 'utf8')).toBeLessThan(
      RELAY_OWNER_MANIFEST_MAX_BYTES
    )
  })

  it('tolerates a trailing newline and CRLF line endings', () => {
    const text = `${serializeRelayOwnerManifest(MANIFEST).replace(/\n/g, '\r\n')}\r\n`
    expect(parseRelayOwnerManifest(text)).toEqual(MANIFEST)
  })

  it('refuses to serialize a manifest whose socket path contains a newline', () => {
    expect(() =>
      serializeRelayOwnerManifest({ ...MANIFEST, socketPath: '/tmp/a\nb.sock' })
    ).toThrow(/newline/i)
  })

  it('refuses to serialize an invalid generation token', () => {
    expect(() => serializeRelayOwnerManifest({ ...MANIFEST, generation: 'nope' })).toThrow(
      /generation/i
    )
  })

  it.each([
    ['empty text', ''],
    ['missing header', 'generation=aaa\npid=1\n'],
    ['unknown version header', `orca-relay-owner-2\n${serializeRelayOwnerManifest(MANIFEST)}`],
    ['missing generation', 'orca-relay-owner-1\npid=12\nsock=/a\ndev=1\nino=2\nctime=3\n'],
    [
      'malformed generation',
      'orca-relay-owner-1\ngeneration=zz\npid=12\nsock=/a\ndev=1\nino=2\nctime=3\n'
    ],
    [
      'non-numeric pid',
      `orca-relay-owner-1\ngeneration=${'a'.repeat(64)}\npid=12x\nsock=/a\ndev=1\nino=2\nctime=3\n`
    ],
    [
      'zero pid',
      `orca-relay-owner-1\ngeneration=${'a'.repeat(64)}\npid=0\nsock=/a\ndev=1\nino=2\nctime=3\n`
    ],
    [
      'negative pid',
      `orca-relay-owner-1\ngeneration=${'a'.repeat(64)}\npid=-9\nsock=/a\ndev=1\nino=2\nctime=3\n`
    ],
    [
      'relative socket path',
      `orca-relay-owner-1\ngeneration=${'a'.repeat(64)}\npid=9\nsock=relay.sock\ndev=1\nino=2\nctime=3\n`
    ],
    [
      'missing inode',
      `orca-relay-owner-1\ngeneration=${'a'.repeat(64)}\npid=9\nsock=/a\ndev=1\nctime=3\n`
    ],
    [
      'missing change time',
      `orca-relay-owner-1\ngeneration=${'a'.repeat(64)}\npid=9\nsock=/a\ndev=1\nino=2\n`
    ],
    ['duplicate key', `${serializeRelayOwnerManifest(MANIFEST)}pid=7\n`],
    ['unknown key', `${serializeRelayOwnerManifest(MANIFEST)}kill=1\n`]
  ])('rejects %s', (_label, text) => {
    expect(parseRelayOwnerManifest(text)).toBeNull()
  })

  it('rejects text larger than the bounded read size', () => {
    const padded = `${serializeRelayOwnerManifest(MANIFEST)}${'#'.repeat(RELAY_OWNER_MANIFEST_MAX_BYTES)}`
    expect(parseRelayOwnerManifest(padded)).toBeNull()
  })

  it('keeps a socket path containing an equals sign intact', () => {
    const manifest = { ...MANIFEST, socketPath: '/tmp/a=b/relay.sock' }
    expect(parseRelayOwnerManifest(serializeRelayOwnerManifest(manifest))).toEqual(manifest)
  })
})
