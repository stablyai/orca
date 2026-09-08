/** The per-chunk metadata main attaches to `pty:data`, and its construction from the wire
 *  payload. Split from the dispatcher so the listener body stays readable; every field is
 *  optional on the wire, and an absent one must stay absent rather than become `undefined`,
 *  because the pre-handler buffer stores meta only when there is something in it. */

export type PtyDataMeta = {
  seq?: number
  rawLength?: number
  transformed?: boolean
  background?: boolean
  /** Main dropped this PTY's buffered output at the pending cap; repaint from the main-owned snapshot, not the live stream. */
  droppedOutput?: boolean
}

export type PtyDataPayload = {
  id: string
  data: string
  seq?: number
  rawLength?: number
  transformed?: boolean
  background?: boolean
  droppedOutput?: boolean
}

export function buildPtyDataMeta(payload: PtyDataPayload): PtyDataMeta | undefined {
  let meta: PtyDataMeta | undefined
  if (typeof payload.seq === 'number') {
    meta ??= {}
    meta.seq = payload.seq
  }
  if (typeof payload.rawLength === 'number') {
    meta ??= {}
    meta.rawLength = payload.rawLength
  }
  if (payload.transformed === true) {
    meta ??= {}
    meta.transformed = true
  }
  if (payload.background === true) {
    meta ??= {}
    meta.background = true
  }
  if (payload.droppedOutput === true) {
    meta ??= {}
    meta.droppedOutput = true
  }
  return meta
}
