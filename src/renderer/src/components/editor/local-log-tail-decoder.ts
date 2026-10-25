import type { LocalLogTailReadResult } from '../../../../shared/local-log-tail-types'
import { decodeBase64Bytes } from '@/lib/base64-bytes'

export const LOCAL_LOG_TAIL_MAX_BYTES = 50 * 1024 * 1024

export type LocalLogTailDecodeResult =
  | { kind: 'append'; content: string; hasMore: boolean }
  | { kind: 'reset' }
  | { kind: 'limit' }

export class LocalLogTailDecoder {
  readonly initialVisibleContent: string
  private byteOffset: number
  private fileIdentity: string
  private readonly decoder = new TextDecoder('utf-8')
  private lineCarry = ''

  constructor(snapshotContent: string, fileIdentity: string) {
    const lastCompleteLineEnd = snapshotContent.lastIndexOf('\n') + 1
    this.initialVisibleContent = snapshotContent.slice(0, lastCompleteLineEnd)
    // Reread the trailing record as bytes to preserve UTF-8 code points split at snapshot EOF.
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
    const decoded = this.decoder.decode(decodeBase64Bytes(result.contentBase64), { stream: true })
    const chunkLineEnd = decoded.lastIndexOf('\n') + 1
    const previousCarryLength = this.lineCarry.length
    this.lineCarry += decoded
    // Why: the carry has no LF, so only newly decoded text can complete a record.
    const lastCompleteLineEnd = chunkLineEnd === 0 ? 0 : previousCarryLength + chunkLineEnd
    if (lastCompleteLineEnd === 0) {
      return { kind: 'append', content: '', hasMore: result.hasMore }
    }
    const content = this.lineCarry.slice(0, lastCompleteLineEnd)
    this.lineCarry = this.lineCarry.slice(lastCompleteLineEnd)
    return { kind: 'append', content, hasMore: result.hasMore }
  }
}
