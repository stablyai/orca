/** Largest window one `fs.readFileRange` response may carry. Derived from the
 *  relay writer's admission budget, NOT from the 16 MiB frame cap.
 *
 *  A response frame over `DISPATCHER_CONTROL_QUEUE_MAX_BYTES` (1 MiB) is demoted
 *  to the `legacy-response` lane, which is refused outright once the producer
 *  queue passes `DEFAULT_PRODUCER_QUEUE_MAX_BYTES` (2 MiB) -- an opaque
 *  `ResponseOverCapacity` that depends on unrelated load. 256 KiB of raw bytes
 *  frames to ~350 KB, so a full-cap response takes the control lane instead.
 *
 *  The control lane is a shared budget, not a per-frame one: two full-cap
 *  responses fit alongside each other, and the third overflows -- which for a
 *  response is fatal, it closes the client. That is the same exposure every
 *  control-lane response already carries (`fs.readFile` frames any sub-1 MiB
 *  file the same way), and the two-deep headroom is pinned by a test. Widening
 *  the cap spends that headroom, so bigger transfers belong on the ack-paced
 *  bulk lane (`fs.readFileStream`) rather than on a wider window here.
 *
 *  Raising this value is a wire change even though it is a constant: an older
 *  host still advertising `rangedReadVersion: 1` refuses a longer window with an
 *  opaque error, so a wider cap needs a version bump to negotiate against.
 *
 *  Requests above it are REJECTED, never clamped: a clamped read is
 *  indistinguishable from EOF, and callers page by advancing `position`. */
export const MAX_FILE_RANGE_READ_BYTES = 256 * 1024

/** A range request the host will refuse. Separate from a read failure so a
 *  caller can tell "I asked for the wrong thing" from "the file is unreadable". */
export class FileRangeReadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FileRangeReadRequestError'
  }
}

/** The single source of truth for what `fs.readFileRange` accepts. Both sides
 *  call it: the client so an invalid request never costs a round trip, the host
 *  because `position`/`length` land straight in an fd read and the relay has no
 *  request schema. Two independent copies would drift into a client that sends
 *  what the host rejects. */
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
