import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  GUEST_TREE_KILL_BINARY,
  GUEST_TREE_KILL_PLATFORMS,
  guestTreeKillSha256
} from './guest-tree-kill-artifacts'

/** Structural ELF fixture only; never execute these bytes. */
export function guestTreeKillElfFixture(machine = 62): Buffer {
  const bytes = Buffer.alloc(120)
  bytes.write('7f454c46', 0, 'hex')
  bytes[4] = 2
  bytes[5] = 1
  bytes[6] = 1
  bytes.writeUInt16LE(2, 16)
  bytes.writeUInt16LE(machine, 18)
  bytes.writeBigUInt64LE(64n, 32)
  bytes.writeUInt16LE(56, 54)
  bytes.writeUInt16LE(1, 56)
  bytes.writeUInt32LE(1, 64)
  return bytes
}

export function writeGuestTreeKillArtifactsFixture(root: string): void {
  const artifacts: Record<string, { sha256: string }> = {}
  for (const platform of GUEST_TREE_KILL_PLATFORMS) {
    const bytes = guestTreeKillElfFixture(platform === 'linux-x64' ? 62 : 183)
    mkdirSync(join(root, platform), { recursive: true })
    writeFileSync(join(root, platform, GUEST_TREE_KILL_BINARY), bytes)
    artifacts[platform] = { sha256: guestTreeKillSha256(bytes) }
  }
  mkdirSync(join(root, 'licenses'), { recursive: true })
  for (const name of ['musl-COPYRIGHT', 'zig-LICENSE']) {
    writeFileSync(join(root, 'licenses', name), 'fixture notice')
  }
  writeFileSync(
    join(root, 'manifest.json'),
    JSON.stringify({ version: 1, sourceSha256: 'fixture', artifacts })
  )
}
