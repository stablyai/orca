export const NATIVE_CHAT_GALLERY_PACKET_BYTES = 64 * 1024
const STRING_PART_LENGTH = 4096
const MAX_PACKET_TOKENS = 256

export type NativeChatGalleryWireToken =
  | { type: 'object' | 'array' | 'end' }
  | { type: 'key'; value: string }
  | { type: 'string'; value: string; last: boolean }
  | { type: 'primitive'; value: number | boolean | null }

function* tokens(value: unknown): Generator<NativeChatGalleryWireToken> {
  if (typeof value === 'string') {
    if (value.length === 0) {
      yield { type: 'string', value: '', last: true }
    }
    for (let start = 0; start < value.length; start += STRING_PART_LENGTH) {
      yield {
        type: 'string',
        value: value.slice(start, start + STRING_PART_LENGTH),
        last: start + STRING_PART_LENGTH >= value.length
      }
    }
  } else if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    yield { type: 'primitive', value }
  } else if (Array.isArray(value)) {
    yield { type: 'array' }
    for (const item of value) {
      yield* tokens(item)
    }
    yield { type: 'end' }
  } else if (typeof value === 'object') {
    yield { type: 'object' }
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) {
        continue
      }
      if (key.length > STRING_PART_LENGTH) {
        throw new Error('Gallery transfer contains an unsupported property name')
      }
      yield { type: 'key', value: key }
      yield* tokens(item)
    }
    yield { type: 'end' }
  } else {
    throw new Error('Gallery transfer contains an unsupported value')
  }
}

/** Bounds both cloned token count and worst-case UTF-8 JSON size, including envelope headroom. */
export function* nativeChatGalleryPackets(value: unknown): Generator<NativeChatGalleryWireToken[]> {
  let packet: NativeChatGalleryWireToken[] = []
  let bytes = 1024
  for (const token of tokens(value)) {
    const cost =
      96 + ('value' in token && typeof token.value === 'string' ? token.value.length * 6 : 0)
    if (bytes + cost > NATIVE_CHAT_GALLERY_PACKET_BYTES || packet.length === MAX_PACKET_TOKENS) {
      yield packet
      packet = []
      bytes = 1024
    }
    packet.push(token)
    bytes += cost
  }
  if (packet.length) {
    yield packet
  }
}

type Frame = { value: Record<string, unknown> | unknown[]; key?: string }

export class NativeChatGalleryWireDecoder {
  private readonly stack: Frame[] = []
  private root: unknown
  private text = ''
  private complete = false

  private append(value: unknown): void {
    const frame = this.stack.at(-1)
    if (!frame) {
      if (this.complete) {
        throw new Error('Gallery transfer has multiple root values')
      }
      this.root = value
      this.complete = true
    } else if (Array.isArray(frame.value)) {
      frame.value.push(value)
    } else if (frame.key !== undefined) {
      Object.defineProperty(frame.value, frame.key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true
      })
      frame.key = undefined
    } else {
      throw new Error('Gallery transfer is missing a property name')
    }
  }

  push(packet: readonly NativeChatGalleryWireToken[]): void {
    for (const token of packet) {
      if (token.type === 'object' || token.type === 'array') {
        const value = token.type === 'array' ? [] : {}
        this.append(value)
        this.stack.push({ value })
      } else if (token.type === 'end') {
        if (!this.stack.pop()) {
          throw new Error('Gallery transfer ended an unopened value')
        }
      } else if (token.type === 'key') {
        const frame = this.stack.at(-1)
        if (!frame || Array.isArray(frame.value) || frame.key !== undefined) {
          throw new Error('Gallery transfer has an unexpected property name')
        }
        frame.key = token.value
      } else if (token.type === 'string') {
        this.text += token.value
        if (token.last) {
          this.append(this.text)
          this.text = ''
        }
      } else if (token.type === 'primitive') {
        this.append(token.value)
      }
    }
  }

  take<T>(): T {
    if (!this.complete || this.stack.length || this.text) {
      throw new Error('Gallery transfer ended before its value was complete')
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Paired internal protocol encoders supply the declared command/result type; authored strings are never interpreted as tokens.
    return this.root as T
  }
}
