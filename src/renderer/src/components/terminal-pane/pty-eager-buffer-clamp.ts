import { clampUtf8TextTail } from '../../../../shared/utf8-byte-limits'

export type EagerBufferChunk = {
  data: string
  bytes: number
}

export function clampUtf8Tail(data: string, maxBytes: number): EagerBufferChunk {
  const tail = clampUtf8TextTail(data, maxBytes)
  return { data: tail.text, bytes: tail.bytes }
}
