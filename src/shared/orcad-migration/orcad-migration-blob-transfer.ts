/** Opaque migration blobs travel beside the signed catalog. Gate each kind by its destination capability:
 * older destinations drop unknown kinds, so clients must refuse before staging. */
import { z } from 'zod'
import {
  ORCAD_MIGRATION_SCROLLBACK_CHUNK_BYTES,
  OrcadMigrationChunkBase64Schema,
  OrcadMigrationDigestSchema,
  OrcadMigrationIdentitySchema,
  decodeOrcadMigrationChunk
} from './orcad-migration-scrollback'
import { requiredRecord } from './orcad-migration-dormant-value-validation'
import { assertUniqueKeys } from './orcad-migration-manifest-fields'
import { ORCAD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY } from '../orcad-runtime-capabilities'

export const ORCAD_MIGRATION_BLOB_KINDS = [
  'terminal-restore-hints',
  'shell-history',
  'agent-session-records',
  'terminal-history'
] as const

export type OrcadMigrationBlobKind = (typeof ORCAD_MIGRATION_BLOB_KINDS)[number]

type OrcadMigrationBlobKindContract = {
  /** Filename-safe, dot-free and lowercase, so a key is one path segment on any filesystem. */
  key: RegExp
  maxBytes: number
  capability: string
}

const MIB = 1024 * 1024

export const ORCAD_MIGRATION_BLOB_KIND_CONTRACTS: Record<
  OrcadMigrationBlobKind,
  OrcadMigrationBlobKindContract
> = {
  // One JSON document per migration; the received directory already scopes it to the migration.
  'terminal-restore-hints': {
    key: /^migration$/,
    maxBytes: 4 * MIB,
    capability: 'orcad.migration-blob.terminal-restore-hints.v1'
  },
  // `hashWorktreeId` (16 hex) plus the shell whose history file it is.
  'shell-history': {
    key: /^[a-f0-9]{16}-(?:zsh|bash|fish)$/,
    maxBytes: 64 * MIB,
    capability: 'orcad.migration-blob.shell-history.v1'
  },
  // The agent session id; agent CLIs mint lowercase UUID-like ids.
  'agent-session-records': {
    key: /^[a-z0-9][a-z0-9_-]{0,127}$/,
    maxBytes: 64 * MIB,
    capability: 'orcad.migration-blob.agent-session-records.v1'
  },
  // 16 hex of the pane key's sha256; the session id it restores as travels inside.
  'terminal-history': {
    key: /^[a-f0-9]{16}$/,
    maxBytes: 16 * MIB,
    capability: 'orcad.migration-blob.terminal-history.v1'
  }
}

// The same bound the shared chunk decoder enforces for both channels.
export const ORCAD_MIGRATION_BLOB_CHUNK_BYTES = ORCAD_MIGRATION_SCROLLBACK_CHUNK_BYTES
export const MAX_ORCAD_MIGRATION_BLOBS = 1024
export const MAX_ORCAD_MIGRATION_BLOB_TOTAL_BYTES = 256 * MIB

/** Byte-for-byte what the destination must hold; empty content is sent as no blob at all. */
export type OrcadMigrationBlobDescriptor = {
  blobKind: OrcadMigrationBlobKind
  key: string
  sha256: string
  byteLength: number
}

export type OrcadMigrationBlobUploadState = OrcadMigrationBlobDescriptor & {
  receivedBytes: number
}

export const ORCAD_MIGRATION_DESTINATION_BLOB_KIND_UNSUPPORTED =
  'orcad_migration_destination_blob_kind_unsupported'

// Windows refuses these as file names whatever the extension, so a key must never be one.
const WINDOWS_RESERVED_FILE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i

export const OrcadMigrationBlobDescriptorSchema = z
  .object({
    blobKind: z.enum(ORCAD_MIGRATION_BLOB_KINDS),
    key: z.string().max(256),
    sha256: OrcadMigrationDigestSchema,
    byteLength: z.number().int().min(1)
  })
  .superRefine((value, context) => {
    const contract = ORCAD_MIGRATION_BLOB_KIND_CONTRACTS[value.blobKind]
    if (!contract.key.test(value.key) || WINDOWS_RESERVED_FILE_NAME.test(value.key)) {
      context.addIssue({
        code: 'custom',
        message: 'orcad_migration_blob_key_invalid'
      })
    }
    if (value.byteLength > contract.maxBytes) {
      context.addIssue({ code: 'custom', message: 'orcad_migration_blob_too_large' })
    }
  })

// Not strict: an older host must ignore optional fields a newer client adds.
export const OrcadMigrationBlobChunkRequestSchema = z.object({
  migrationId: OrcadMigrationIdentitySchema,
  manifestSha256: OrcadMigrationDigestSchema,
  blob: OrcadMigrationBlobDescriptorSchema,
  offset: z.number().int().nonnegative().max(MAX_ORCAD_MIGRATION_BLOB_TOTAL_BYTES),
  bytesBase64: OrcadMigrationChunkBase64Schema
})

export type OrcadMigrationBlobChunkRequest = z.infer<typeof OrcadMigrationBlobChunkRequestSchema>

export type OrcadMigrationBlobChunkResult = {
  migrationId: string
  manifestSha256: string
  blobKind: OrcadMigrationBlobKind
  key: string
  receivedBytes: number
}

export function parseOrcadMigrationBlobDescriptor(value: unknown): OrcadMigrationBlobDescriptor {
  const parsed = OrcadMigrationBlobDescriptorSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'orcad_migration_blob_descriptor_invalid')
  }
  return {
    blobKind: parsed.data.blobKind,
    key: parsed.data.key,
    sha256: parsed.data.sha256,
    byteLength: parsed.data.byteLength
  }
}

export function assertOrcadMigrationBlobSet(
  descriptors: readonly OrcadMigrationBlobDescriptor[]
): void {
  if (descriptors.length > MAX_ORCAD_MIGRATION_BLOBS) {
    throw new Error('orcad_migration_blobs_too_many')
  }
  assertUniqueKeys([...descriptors], orcadMigrationBlobIdentity, 'orcad_migration_blob_duplicate')
  const total = descriptors.reduce((sum, entry) => sum + entry.byteLength, 0)
  if (total > MAX_ORCAD_MIGRATION_BLOB_TOTAL_BYTES) {
    throw new Error('orcad_migration_blobs_too_large')
  }
}

export function orcadMigrationBlobIdentity(
  descriptor: Pick<OrcadMigrationBlobDescriptor, 'blobKind' | 'key'>
): string {
  return `${descriptor.blobKind}\0${descriptor.key}`
}

export function sameOrcadMigrationBlob(
  left: OrcadMigrationBlobDescriptor,
  right: OrcadMigrationBlobDescriptor
): boolean {
  return (
    left.blobKind === right.blobKind &&
    left.key === right.key &&
    left.sha256 === right.sha256 &&
    left.byteLength === right.byteLength
  )
}

/** The channel plus each kind's capability; empty when nothing is sent. */
export function requiredMigrationBlobCapabilities(
  descriptors: readonly Pick<OrcadMigrationBlobDescriptor, 'blobKind'>[]
): string[] {
  if (descriptors.length === 0) {
    return []
  }
  const kinds = new Set(descriptors.map((entry) => entry.blobKind))
  return [
    ORCAD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY,
    ...ORCAD_MIGRATION_BLOB_KINDS.filter((kind) => kinds.has(kind)).map(
      (kind) => ORCAD_MIGRATION_BLOB_KIND_CONTRACTS[kind].capability
    )
  ]
}

/** The first kind the destination cannot install, so the refusal names what would be lost. */
export function findUnsupportedMigrationBlobKind(
  descriptors: readonly Pick<OrcadMigrationBlobDescriptor, 'blobKind'>[],
  capabilities: readonly string[]
): OrcadMigrationBlobKind | null {
  const advertised = new Set(capabilities)
  for (const descriptor of descriptors) {
    if (
      !advertised.has(ORCAD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY) ||
      !advertised.has(ORCAD_MIGRATION_BLOB_KIND_CONTRACTS[descriptor.blobKind].capability)
    ) {
      return descriptor.blobKind
    }
  }
  return null
}

export function orcadMigrationBlobKindUnsupportedBlocker(kind: OrcadMigrationBlobKind): string {
  return `${ORCAD_MIGRATION_DESTINATION_BLOB_KIND_UNSUPPORTED}:${kind}:Update Orca on this host to move this project's ${kind} to it.`
}

export function decodeOrcadMigrationBlobChunk(bytesBase64: string): Buffer {
  return decodeOrcadMigrationChunk(bytesBase64, 'orcad_migration_blob_chunk_invalid')
}

/** Absent on hosts that predate blobs or hold none staged; both mean every blob starts at 0. */
export function parseOrcadMigrationBlobUploadStates(
  value: unknown
): OrcadMigrationBlobUploadState[] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value) || value.length > MAX_ORCAD_MIGRATION_BLOBS) {
    throw new Error('orcad_migration_blob_state_invalid')
  }
  const uploads = value.map((entry) => {
    // Fails closed on an unknown kind by design: only blobs this desktop staged can appear here.
    const record = requiredRecord(entry, 'orcad_migration_blob_state_invalid')
    const descriptor = parseOrcadMigrationBlobDescriptor(record)
    if (
      !Number.isSafeInteger(record.receivedBytes) ||
      Number(record.receivedBytes) < 0 ||
      Number(record.receivedBytes) > descriptor.byteLength
    ) {
      throw new Error('orcad_migration_blob_state_invalid')
    }
    return { ...descriptor, receivedBytes: Number(record.receivedBytes) }
  })
  assertOrcadMigrationBlobSet(uploads)
  return uploads
}

export function parseOrcadMigrationBlobChunkResult(
  value: unknown,
  request: OrcadMigrationBlobChunkRequest
): OrcadMigrationBlobChunkResult {
  const record = requiredRecord(value, 'orcad_migration_blob_chunk_result_invalid')
  const receivedBytes = request.offset + decodeOrcadMigrationBlobChunk(request.bytesBase64).length
  if (
    record.migrationId !== request.migrationId ||
    record.manifestSha256 !== request.manifestSha256 ||
    record.blobKind !== request.blob.blobKind ||
    record.key !== request.blob.key ||
    record.receivedBytes !== receivedBytes
  ) {
    throw new Error('orcad_migration_blob_chunk_result_invalid')
  }
  return {
    migrationId: request.migrationId,
    manifestSha256: request.manifestSha256,
    blobKind: request.blob.blobKind,
    key: request.blob.key,
    receivedBytes
  }
}

/** Kinds this build's destination installs after commit; each is added with its installer. */
export const ORCAD_MIGRATION_INSTALLABLE_BLOB_KINDS: readonly OrcadMigrationBlobKind[] = [
  'terminal-restore-hints',
  'shell-history',
  'terminal-history'
]

/** Moved panes' terminal history installs only on a WSL host, the one destination a WSL move has. */
export function advertisedOrcadMigrationBlobCapabilities(host: { wslHost: boolean }): string[] {
  return [
    ORCAD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY,
    ...ORCAD_MIGRATION_INSTALLABLE_BLOB_KINDS.filter(
      (kind) => kind !== 'terminal-history' || host.wslHost
    ).map((kind) => ORCAD_MIGRATION_BLOB_KIND_CONTRACTS[kind].capability)
  ]
}
