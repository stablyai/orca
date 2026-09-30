import {
  closeSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertGuestTreeKillArtifacts,
  assertStaticGuestTreeKillElf,
  readGuestTreeKillArtifact
} from './guest-tree-kill-artifacts'
import {
  guestTreeKillElfFixture,
  writeGuestTreeKillArtifactsFixture
} from './guest-tree-kill-artifacts-test-fixture'

const scratch: string[] = []
afterEach(() => {
  for (const path of scratch.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-guest-artifacts-'))
  scratch.push(root)
  writeGuestTreeKillArtifactsFixture(root)
  return root
}

describe('guest tree cleanup artifacts', () => {
  it('requires both guest architectures with exact recorded hashes', () => {
    const root = fixture()
    expect(() => assertGuestTreeKillArtifacts(root)).not.toThrow()
    expect(readGuestTreeKillArtifact(root, 'linux-arm64').path).toBe(
      join(root, 'linux-arm64', 'orca-guest-tree-kill')
    )
    writeFileSync(join(root, 'linux-x64', 'orca-guest-tree-kill'), guestTreeKillElfFixture(183))
    expect(() => assertGuestTreeKillArtifacts(root)).toThrow(/digest mismatch/)
  })

  it('returns the exact verified bytes and refuses oversized regular files', () => {
    const root = fixture()
    const artifact = readGuestTreeKillArtifact(root, 'linux-x64')
    expect(artifact.bytes).toEqual(guestTreeKillElfFixture())
    const fd = openSync(artifact.path, 'r+')
    try {
      ftruncateSync(fd, 1024 * 1024 + 1)
    } finally {
      closeSync(fd)
    }
    expect(() => readGuestTreeKillArtifact(root, 'linux-x64')).toThrow(/File too large/)
  })

  it('refuses a missing architecture and incompatible manifest', () => {
    const root = fixture()
    rmSync(join(root, 'linux-arm64', 'orca-guest-tree-kill'))
    expect(() => assertGuestTreeKillArtifacts(root)).toThrow()
    const path = join(root, 'manifest.json')
    writeFileSync(path, readFileSync(path, 'utf8').replace('"version":1', '"version":2'))
    expect(() => readGuestTreeKillArtifact(root, 'linux-x64')).toThrow(/incompatible/)
  })

  it.each([2, 3])('rejects ELF program type %i even with the right architecture', (type) => {
    const bytes = guestTreeKillElfFixture()
    bytes.writeUInt32LE(type, 64)
    expect(() => assertStaticGuestTreeKillElf(bytes, 'linux-x64')).toThrow(/guest loader/)
  })

  it('rejects a foreign architecture, ELF class, byte order and truncated headers', () => {
    expect(() => assertStaticGuestTreeKillElf(guestTreeKillElfFixture(183), 'linux-x64')).toThrow()
    for (const offset of [4, 5]) {
      const bytes = guestTreeKillElfFixture()
      bytes[offset] = 0
      expect(() => assertStaticGuestTreeKillElf(bytes, 'linux-x64')).toThrow()
    }
    expect(() => assertStaticGuestTreeKillElf(Buffer.alloc(20), 'linux-x64')).toThrow()
  })

  it('rejects invalid program-header offsets without reading outside the buffer', () => {
    const bytes = guestTreeKillElfFixture()
    bytes.writeBigUInt64LE(0xffffffffffffffffn, 32)
    expect(() => assertStaticGuestTreeKillElf(bytes, 'linux-x64')).toThrow(/program table/)
  })
})
