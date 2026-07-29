import { randomUUID, type Hash } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  NodeFileReadTooLargeError,
  readNodeFileSyncWithinLimit,
  type BoundedNodeFileRead
} from './node-bounded-file-reader'
import {
  JsonStringifyByteLimitError,
  stringifyJsonWithinByteLimit
} from './node-bounded-json-stringify'
import {
  assertJsonTextStructureWithinLimits,
  type JsonTextStructureLimits
} from './json-text-structure-limit'

export const ORCA_PERSISTED_STATE_MAX_BYTES = 64 * 1024 * 1024
export const ORCA_PERSISTED_STATE_SECRET_MAX_BYTES = 4 * 1024 * 1024
export const ORCA_PERSISTED_STATE_HASH_CHUNK_CODE_UNITS = 64 * 1024
export const ORCA_PERSISTED_STATE_JSON_LIMITS: JsonTextStructureLimits = {
  structuralTokens: 4_000_000,
  nestingDepth: 256
}

export type PersistedStateJsonRead<T> = {
  byteLength: number
  value: T
}

export class PersistedStateSecretCapacityError extends Error {
  constructor(
    readonly observedBytes: number,
    readonly maxBytes = ORCA_PERSISTED_STATE_SECRET_MAX_BYTES
  ) {
    super(`Persisted state secret exceeds ${maxBytes} bytes`)
    this.name = 'PersistedStateSecretCapacityError'
  }
}

export function isPersistedStateFileCapacityError(
  error: unknown
): error is NodeFileReadTooLargeError {
  return error instanceof NodeFileReadTooLargeError
}

export function readPersistedStateJsonFileSync<T>(
  filePath: string,
  maxBytes = ORCA_PERSISTED_STATE_MAX_BYTES,
  structureLimits: JsonTextStructureLimits = ORCA_PERSISTED_STATE_JSON_LIMITS
): PersistedStateJsonRead<T> {
  const { buffer } = readPersistedStateFileBytesSync(filePath, maxBytes)
  return {
    byteLength: buffer.byteLength,
    value: parsePersistedStateJsonBuffer<T>(buffer, structureLimits)
  }
}

export function readPersistedStateFileBytesSync(
  filePath: string,
  maxBytes = ORCA_PERSISTED_STATE_MAX_BYTES
): BoundedNodeFileRead {
  return readNodeFileSyncWithinLimit(filePath, maxBytes)
}

export function parsePersistedStateJsonBuffer<T>(
  buffer: Buffer,
  structureLimits: JsonTextStructureLimits = ORCA_PERSISTED_STATE_JSON_LIMITS
): T {
  const serialized = buffer.toString('utf8')
  assertJsonTextStructureWithinLimits(serialized, structureLimits)
  return JSON.parse(serialized) as T
}

export function stringifyPersistedStateWithinLimit(
  value: unknown,
  maxBytes = ORCA_PERSISTED_STATE_MAX_BYTES
): { byteLength: number; serialized: string } {
  return stringifyJsonWithinByteLimit(value, maxBytes)
}

export function stringifyPrettyPersistedStateWithinLimit(
  value: unknown,
  maxBytes = ORCA_PERSISTED_STATE_MAX_BYTES
): { byteLength: number; serialized: string } {
  return stringifyJsonWithinByteLimit(value, maxBytes, 2)
}

export function encodePersistedStateJsonStringContent(
  value: string,
  maxBytes = ORCA_PERSISTED_STATE_MAX_BYTES
): string {
  const { serialized } = stringifyJsonWithinByteLimit(value, maxBytes)
  return serialized.slice(1, -1)
}

export function assertPersistedStateSecretWithinLimit(
  value: string,
  maxBytes = ORCA_PERSISTED_STATE_SECRET_MAX_BYTES
): void {
  const observedBytes = Buffer.byteLength(value, 'utf8')
  if (observedBytes > maxBytes) {
    throw new PersistedStateSecretCapacityError(observedBytes, maxBytes)
  }
}

export function replacedPersistedStateJsonByteLength(options: {
  currentBytes: number
  maxBytes?: number
  replacement: string
  search: string
}): number {
  const maxBytes = options.maxBytes ?? ORCA_PERSISTED_STATE_MAX_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('Persisted state JSON byte limit must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(options.currentBytes) || options.currentBytes < 0) {
    throw new RangeError('Persisted state JSON byte count must be a non-negative safe integer')
  }
  if (options.currentBytes > maxBytes) {
    throw new JsonStringifyByteLimitError(options.currentBytes, maxBytes)
  }
  const nextBytes =
    options.currentBytes -
    Buffer.byteLength(options.search, 'utf8') +
    Buffer.byteLength(options.replacement, 'utf8')
  if (!Number.isSafeInteger(nextBytes) || nextBytes < 0 || nextBytes > maxBytes) {
    throw new JsonStringifyByteLimitError(nextBytes, maxBytes)
  }
  return nextBytes
}

export function replacePersistedStateJsonWithinLimit(options: {
  currentBytes: number
  maxBytes?: number
  replacement: string
  search: string
  serialized: string
}): { byteLength: number; serialized: string } {
  const byteLength = replacedPersistedStateJsonByteLength(options)
  const searchIndex = options.serialized.indexOf(options.search)
  if (searchIndex === -1) {
    throw new Error('Persisted state JSON replacement slot is missing')
  }
  if (options.serialized.includes(options.search, searchIndex + options.search.length)) {
    throw new Error('Persisted state JSON replacement slot is ambiguous')
  }
  return {
    byteLength,
    serialized: options.serialized.replace(options.search, () => options.replacement)
  }
}

export function updatePersistedStateHashWithJsonRange(
  hash: Pick<Hash, 'update'>,
  value: string,
  start = 0,
  end = value.length,
  chunkCodeUnits = ORCA_PERSISTED_STATE_HASH_CHUNK_CODE_UNITS
): void {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end > value.length
  ) {
    throw new RangeError('Persisted state hash range is invalid')
  }
  if (!Number.isSafeInteger(chunkCodeUnits) || chunkCodeUnits <= 0) {
    throw new RangeError('Persisted state hash chunk size must be a positive safe integer')
  }

  let offset = start
  while (offset < end) {
    let nextOffset = Math.min(end, offset + chunkCodeUnits)
    if (
      nextOffset < end &&
      isHighSurrogate(value.charCodeAt(nextOffset - 1)) &&
      isLowSurrogate(value.charCodeAt(nextOffset))
    ) {
      nextOffset += 1
    }
    hash.update(value.slice(offset, nextOffset), 'utf8')
    offset = nextOffset
  }
}

export function restorePersistedStateBackupSync(
  sourcePath: string,
  targetPath: string,
  maxBytes = ORCA_PERSISTED_STATE_MAX_BYTES
): number {
  const read = readValidatedPersistedStateBytesSync(sourcePath, maxBytes)
  mkdirSync(dirname(targetPath), { recursive: true })
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.recovery.tmp`
  try {
    writeFileSync(temporaryPath, read.buffer)
    renameSync(temporaryPath, targetPath)
  } catch (error) {
    rmSync(temporaryPath, { force: true })
    throw error
  }
  return read.buffer.byteLength
}

function readValidatedPersistedStateBytesSync(
  filePath: string,
  maxBytes: number
): BoundedNodeFileRead {
  const read = readPersistedStateFileBytesSync(filePath, maxBytes)
  parsePersistedStateJsonBuffer(read.buffer)
  return read
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}
