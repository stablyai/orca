import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { z } from 'zod'
import {
  splitRuntimeSnapshotStructure,
  restoreRuntimeSnapshotStructure
} from './remote-runtime-snapshot-structure'
import {
  parseRemoteRuntimeJsonText,
  REMOTE_RUNTIME_JSON_STRUCTURE_LIMITS
} from './remote-runtime-request-frames'
import {
  assertJsonTextStructureWithinLimits,
  JsonTextStructureCapacityError
} from './json-text-structure-limit'

export const RUNTIME_SNAPSHOT_DEFLATE_CAPABILITY = 'remote-runtime.snapshot-deflate.v1' as const
export const MAX_RUNTIME_SNAPSHOT_COMPRESSION_BYTES = 256 * 1024
const MIN_COMPRESSION_BYTES = 1024
const CompressedResult = z.object({
  encoding: z.literal('deflate-raw'),
  bytes: z.number().int().min(1).max(MAX_RUNTIME_SNAPSHOT_COMPRESSION_BYTES),
  resultBytes: z.number().int().min(1).max(MAX_RUNTIME_SNAPSHOT_COMPRESSION_BYTES),
  literals: z.array(z.unknown()).max(16_384),
  data: z.string().max(MAX_RUNTIME_SNAPSHOT_COMPRESSION_BYTES * 2)
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function compressRuntimeSnapshotResponse(response: string): string {
  // Bound work before parsing or allocating zlib state; large snapshots keep the legacy path.
  if (response.length > MAX_RUNTIME_SNAPSHOT_COMPRESSION_BYTES) {
    return response
  }
  let envelope: unknown
  try {
    envelope = parseRemoteRuntimeJsonText(response)
  } catch (error) {
    if (error instanceof JsonTextStructureCapacityError) {
      return response
    }
    throw error
  }
  if (
    !isRecord(envelope) ||
    envelope.ok !== true ||
    envelope.streaming !== true ||
    !isRecord(envelope.result) ||
    !['snapshot', 'snapshots', 'updated'].includes(String(envelope.result.type))
  ) {
    return response
  }
  const result = JSON.stringify(envelope.result)
  const bytes = Buffer.byteLength(result)
  if (bytes < MIN_COMPRESSION_BYTES || bytes > MAX_RUNTIME_SNAPSHOT_COMPRESSION_BYTES) {
    return response
  }
  const { structure, literals } = splitRuntimeSnapshotStructure(envelope.result)
  if (literals.length > 16_384) {
    return response
  }
  const serialized = JSON.stringify(structure)
  const structureBytes = Buffer.byteLength(serialized)
  if (structureBytes > MAX_RUNTIME_SNAPSHOT_COMPRESSION_BYTES) {
    return response
  }
  // The separate literal sidecar never enters zlib, including prompts/messages nested in agentStatus.
  const data = deflateRawSync(serialized, { level: 1, windowBits: 15, memLevel: 5 }).toString(
    'base64'
  )
  const compressed = JSON.stringify({
    ...envelope,
    result: null,
    compressedResult: {
      encoding: 'deflate-raw',
      bytes: structureBytes,
      resultBytes: bytes,
      data,
      literals
    }
  })
  try {
    assertJsonTextStructureWithinLimits(compressed, REMOTE_RUNTIME_JSON_STRUCTURE_LIMITS)
  } catch (error) {
    if (error instanceof JsonTextStructureCapacityError) {
      return response
    }
    throw error
  }
  return Buffer.byteLength(compressed) < Buffer.byteLength(response) ? compressed : response
}

export function decodeRuntimeSnapshotResponse(raw: unknown, negotiated: boolean): unknown {
  if (!isRecord(raw) || !('compressedResult' in raw)) {
    return raw
  }
  if (!negotiated || raw.ok !== true || raw.streaming !== true || raw.result !== null) {
    throw new Error('Unexpected compressed runtime snapshot')
  }
  const { bytes, resultBytes, data, literals } = CompressedResult.parse(raw.compressedResult)
  if (Buffer.byteLength(JSON.stringify(literals)) > MAX_RUNTIME_SNAPSHOT_COMPRESSION_BYTES) {
    throw new Error('Runtime snapshot literals exceed byte limit')
  }
  const compressed = Buffer.from(data, 'base64')
  if (
    compressed.length > MAX_RUNTIME_SNAPSHOT_COMPRESSION_BYTES ||
    compressed.toString('base64') !== data
  ) {
    throw new Error('Invalid compressed runtime snapshot encoding')
  }
  const result = inflateRawSync(compressed, { windowBits: 15, maxOutputLength: bytes })
  if (result.byteLength !== bytes) {
    throw new Error('Invalid compressed runtime snapshot length')
  }
  const decoded = restoreRuntimeSnapshotStructure(
    parseRemoteRuntimeJsonText(result.toString('utf8')),
    literals
  )
  if (Buffer.byteLength(JSON.stringify(decoded)) !== resultBytes) {
    throw new Error('Invalid restored runtime snapshot length')
  }
  if (!isRecord(decoded) || !['snapshot', 'snapshots', 'updated'].includes(String(decoded.type))) {
    throw new Error('Invalid compressed runtime snapshot result')
  }
  const { compressedResult: _compressedResult, ...envelope } = raw
  const restored = { ...envelope, result: decoded }
  assertJsonTextStructureWithinLimits(
    JSON.stringify(restored),
    REMOTE_RUNTIME_JSON_STRUCTURE_LIMITS
  )
  return restored
}
