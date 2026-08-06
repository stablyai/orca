import type { LocalLogTailReadResult } from '../../../../shared/local-log-tail-types'

export const LOCAL_LOG_TAIL_MAX_BYTES = 50 * 1024 * 1024

export type LocalLogTailDecodeResult =
  | { kind: 'append'; content: string; hasMore: boolean }
  | { kind: 'reset' }
  | { kind: 'limit' }

function decodeBase64(contentBase64: string): Uint8Array {
  const binary = atob(contentBase64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export class LocalLogTailDecoder {
  readonly initialVisibleContent: string
  private byteOffset: number
  private fileIdentity: string
  private readonly decoder = new TextDecoder('utf-8')
  private lineCarry = ''

  constructor(snapshotContent: string, fileIdentity: string) {
    const lastCompleteLineEnd = snapshotContent.lastIndexOf('\n') + 1
    this.initialVisibleContent = snapshotContent.slice(0, lastCompleteLineEnd)
    // Why: rewind to the last complete line, then re-read the trailing record as
    // bytes. This preserves a UTF-8 code point split at the snapshot EOF.
    this.byteOffset = new TextEncoder().encode(this.initialVisibleContent).byteLength
    this.fileIdentity = fileIdentity
  }

  get nextByteOffset(): number {
    return this.byteOffset
  }

  get expectedIdentity(): string {
    return this.fileIdentity
  }

  apply(result: LocalLogTailReadResult): LocalLogTailDecodeResult {
    if (result.reset) {
      return { kind: 'reset' }
    }
    if (result.nextByteOffset > LOCAL_LOG_TAIL_MAX_BYTES) {
      return { kind: 'limit' }
    }

    this.byteOffset = result.nextByteOffset
    this.fileIdentity = result.fileIdentity
    this.lineCarry += this.decoder.decode(decodeBase64(result.contentBase64), { stream: true })
    const lastCompleteLineEnd = this.lineCarry.lastIndexOf('\n') + 1
    if (lastCompleteLineEnd === 0) {
      return { kind: 'append', content: '', hasMore: result.hasMore }
    }
    const content = this.lineCarry.slice(0, lastCompleteLineEnd)
    this.lineCarry = this.lineCarry.slice(lastCompleteLineEnd)
    return { kind: 'append', content, hasMore: result.hasMore }
  }
}
