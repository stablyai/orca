import type { PtyIngressSourceSpan } from './pty-startup-ingress-contract'
import { isShellProcess } from './shell-process-detection'
import {
  EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE,
  scanTerminalReplyQuerySequences,
  type TerminalReplyQueryScanState
} from './terminal-reply-query-scan'

export type ForegroundProcessReader = () => string | null | undefined

export function readForegroundProcess(
  reader: ForegroundProcessReader | undefined
): string | null | undefined {
  try {
    return reader?.()
  } catch {
    return undefined
  }
}

export function shouldInjectQueryReplyForOwner(
  queryOwner: string | null | undefined,
  foregroundProcess: string | null | undefined
): boolean {
  if (foregroundProcess == null || foregroundProcess === '') {
    return true
  }
  if (queryOwner == null || queryOwner === '') {
    return !isShellProcess(foregroundProcess)
  }
  return foregroundProcess === queryOwner
}

export function shouldInjectQueryReplyForOwnerFromProcess(
  queryOwner: string | null | undefined,
  reader: ForegroundProcessReader | undefined
): boolean {
  return shouldInjectQueryReplyForOwner(queryOwner, readForegroundProcess(reader))
}

/** Remembers who emitted the last query whose reply can echo into a cooked PTY. */
export class TerminalQueryOwnerTracker {
  private scanState: TerminalReplyQueryScanState = EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
  private pendingOwner: string | null | undefined
  private value: string | null | undefined

  constructor(private readonly reader: ForegroundProcessReader | undefined) {}

  get owner(): string | null | undefined {
    return this.value
  }

  accept(span: PtyIngressSourceSpan): void {
    const previous = this.scanState
    const scan = scanTerminalReplyQuerySequences(span.data, span.rawStartSeq, previous)
    this.scanState = scan.state
    const cookedQueries = scan.queries.filter(
      (query) =>
        query.data.startsWith('\x1b]') ||
        (query.data.startsWith('\x1b[?') && query.data.endsWith('n'))
    )
    const latest = cookedQueries.at(-1)
    if (latest) {
      this.value =
        latest.startSeq < span.rawStartSeq ? this.pendingOwner : readForegroundProcess(this.reader)
    }
    if (scan.state.pendingStartSeq !== previous.pendingStartSeq) {
      this.pendingOwner = scan.state.pending ? readForegroundProcess(this.reader) : undefined
    }
  }
}
