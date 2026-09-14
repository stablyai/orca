import { stringifyJsonWithinByteLimit } from './node-bounded-json-stringify'
import { writeSecureFileAsync } from './secure-file-async-write'
import { writeSecureFile } from './secure-file'

export function writeSecureJsonFileWithinLimit(
  targetPath: string,
  value: unknown,
  maxBytes: number,
  options: { durable?: boolean } = {}
): void {
  writeSecureFile(targetPath, stringifyJsonWithinByteLimit(value, maxBytes).serialized, options)
}

/** Async lane; see `writeSecureFileAsync`. */
export async function writeSecureJsonFileWithinLimitAsync(
  targetPath: string,
  value: unknown,
  maxBytes: number,
  options: { durable?: boolean } = {}
): Promise<void> {
  await writeSecureFileAsync(
    targetPath,
    stringifyJsonWithinByteLimit(value, maxBytes).serialized,
    options
  )
}
