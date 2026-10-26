/** 256 KiB raw becomes ~350 KB encoded, fitting the relay’s 1 MiB shared control queue, not merely its 16 MiB frame cap.
 * Larger frames enter legacy-response, which rejects above the 2 MiB producer budget. Two capped control responses fit; a third
 * is rejected per request with ResponseOverCapacity (controlOverflow: reject), without closing the connection. Tests pin this headroom.
 * Larger transfers belong on ack-paced fs.readFileStream. Raising the cap requires negotiating a rangedReadVersion bump; v1 hosts refuse it.
 * Reject oversized requests; never clamp, since a short response looks like EOF to position-based paging. */
export const MAX_FILE_RANGE_READ_BYTES = 256 * 1024

/** Distinguish invalid range requests from unreadable-file failures. */
export class FileRangeReadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FileRangeReadRequestError'
  }
}

/** Validate on both peers to avoid client round trips and protect host fd reads; the relay has no request schema. */
export function validateFileRangeRequest(
  position: unknown,
  length: unknown
): { position: number; length: number } {
  if (typeof position !== 'number' || !Number.isSafeInteger(position) || position < 0) {
    throw new FileRangeReadRequestError(
      'fs.readFileRange requires a non-negative safe-integer position'
    )
  }
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length <= 0) {
    throw new FileRangeReadRequestError('fs.readFileRange requires a positive integer length')
  }
  if (length > MAX_FILE_RANGE_READ_BYTES) {
    throw new FileRangeReadRequestError(
      `fs.readFileRange length ${length} exceeds the ${MAX_FILE_RANGE_READ_BYTES}-byte limit`
    )
  }
  if (position > Number.MAX_SAFE_INTEGER - (length - 1)) {
    throw new FileRangeReadRequestError('fs.readFileRange window exceeds safe-integer offsets')
  }
  return { position, length }
}
