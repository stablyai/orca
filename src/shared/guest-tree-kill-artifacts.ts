import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readNodeFileSyncWithinLimit } from './node-bounded-file-reader'

export const GUEST_TREE_KILL_RESOURCE_DIR = 'guest-tree-kill'
export const GUEST_TREE_KILL_BINARY = 'orca-guest-tree-kill'
export const GUEST_TREE_KILL_PLATFORMS = ['linux-x64', 'linux-arm64'] as const
export type GuestTreeKillPlatform = (typeof GUEST_TREE_KILL_PLATFORMS)[number]
export const GUEST_TREE_KILL_MAX_BYTES = 1024 * 1024
export type GuestTreeKillArtifact = { path: string; sha256: string; bytes: Buffer }
const MACHINES = { 'linux-x64': 62, 'linux-arm64': 183 }

/** Refuse dynamic loaders and dependencies even when the ELF names the correct architecture. */
export function assertStaticGuestTreeKillElf(bytes: Buffer, platform: GuestTreeKillPlatform): void {
  if (
    bytes.length < 64 ||
    bytes.toString('hex', 0, 4) !== '7f454c46' ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    bytes[6] !== 1 ||
    bytes.readUInt16LE(16) !== 2 ||
    bytes.readUInt16LE(18) !== MACHINES[platform]
  ) {
    throw new Error(`Guest cleanup helper is not a static ELF executable for ${platform}`)
  }
  const offset = Number(bytes.readBigUInt64LE(32))
  const stride = bytes.readUInt16LE(54)
  const count = bytes.readUInt16LE(56)
  if (
    !Number.isSafeInteger(offset) ||
    offset < 64 ||
    stride < 56 ||
    count === 0 ||
    offset + stride * count > bytes.length
  ) {
    throw new Error('Guest cleanup helper has an invalid ELF program table')
  }
  let loadable = false
  for (let index = 0; index < count; index++) {
    const type = bytes.readUInt32LE(offset + index * stride)
    if (type === 2 || type === 3) {
      throw new Error('Guest cleanup helper must not depend on a guest loader or shared libraries')
    }
    loadable ||= type === 1
  }
  if (!loadable) {
    throw new Error('Guest cleanup helper has no loadable ELF segment')
  }
}

export function guestTreeKillSha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function readGuestTreeKillManifest(root: string): unknown {
  return JSON.parse(
    readNodeFileSyncWithinLimit(join(root, 'manifest.json'), 64 * 1024, {
      requireRegularFile: true
    }).buffer.toString('utf8')
  )
}

/** Manifest paths are never used to select executables; every artifact has a fixed relative path. */
export function readGuestTreeKillArtifact(
  root: string,
  platform: GuestTreeKillPlatform
): GuestTreeKillArtifact {
  const manifest = readGuestTreeKillManifest(root)
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    !('version' in manifest) ||
    manifest.version !== 1 ||
    !('artifacts' in manifest) ||
    !manifest.artifacts ||
    typeof manifest.artifacts !== 'object' ||
    !(platform in manifest.artifacts)
  ) {
    throw new Error('Guest cleanup helper manifest is missing or incompatible')
  }
  const entry: unknown = Reflect.get(manifest.artifacts, platform)
  if (
    !entry ||
    typeof entry !== 'object' ||
    !('sha256' in entry) ||
    typeof entry.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(entry.sha256)
  ) {
    throw new Error(`Guest cleanup helper has no valid digest for ${platform}`)
  }
  const path = join(root, platform, GUEST_TREE_KILL_BINARY)
  const bytes = readNodeFileSyncWithinLimit(path, GUEST_TREE_KILL_MAX_BYTES, {
    requireRegularFile: true
  }).buffer
  if (guestTreeKillSha256(bytes) !== entry.sha256) {
    throw new Error(`Guest cleanup helper digest mismatch: ${platform}`)
  }
  assertStaticGuestTreeKillElf(bytes, platform)
  return { path, sha256: entry.sha256, bytes }
}

export function assertGuestTreeKillArtifacts(root: string): void {
  for (const platform of GUEST_TREE_KILL_PLATFORMS) {
    readGuestTreeKillArtifact(root, platform)
  }
}
