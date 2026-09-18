import { clampUtf8TextTail } from '../../../../shared/utf8-byte-limits'
import { flattenRetainedSlice } from '../../lib/flatten-retained-slice'

export type EagerBufferChunk = {
  data: string
  bytes: number
}

export function clampUtf8Tail(data: string, maxBytes: number): EagerBufferChunk {
  const tail = clampUtf8TextTail(data, maxBytes)
  return {
    data: tail.text.length < data.length ? flattenRetainedSlice(tail.text) : tail.text,
    bytes: tail.bytes
  }
}
