import type { PtyIngressSourceSpan } from './pty-startup-ingress-contract'
import { isShellProcess } from './shell-process-detection'
import {
  EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE,
  scanTerminalReplyQuerySequences,
  type TerminalReplyQueryScanState
} from './terminal-reply-query-scan'
import { classifyTerminalQueryReply, type TerminalQueryReplyKind } from './terminal-query-reply'

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

const MAX_OUTSTANDING_QUERIES = 64

type OutstandingQuery = {
  kind: TerminalQueryReplyKind
  owner: string | null | undefined
}

export type TerminalQueryReplyOwnerClaim =
  | { matched: false }
  | { matched: true; owner: string | null | undefined }

function expectedReplyKind(query: string): TerminalQueryReplyKind | null {
  if (query === '\x1b[5n') {
    return 'dsr'
  }
  if (query === '\x1b[6n' || query === '\x1b[?6n') {
    return 'cpr'
  }
  if (query === '\x1b[?996n') {
    return 'private-dsr'
  }
  if (query === '\x1b[14t' || query === '\x1b[16t' || query === '\x1b[18t') {
    return 'window-report'
  }
  if (query === '\x1b[?u') {
    return 'kitty-flags'
  }
  if (query === '\x1b[>q') {
    return 'dcs-report'
  }
  if (query.startsWith('\x1b]')) {
    return 'osc-color'
  }
  if (query.startsWith('\x1bP')) {
    return 'dcs-report'
  }
  if (query.endsWith('$p')) {
    return 'mode-report'
  }
  if (query.endsWith('c')) {
    return 'device-attributes'
  }
  return null
}

/** Remembers each reply-eliciting query and the foreground process that emitted it. */
export class TerminalQueryOwnerTracker {
  private scanState: TerminalReplyQueryScanState = EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
  private pendingOwner: string | null | undefined
  private value: string | null | undefined
  private readonly outstanding: OutstandingQuery[] = []

  constructor(private readonly reader: ForegroundProcessReader | undefined) {}

  get owner(): string | null | undefined {
    return this.value
  }

  accept(span: PtyIngressSourceSpan): void {
    const previous = this.scanState
    const scan = scanTerminalReplyQuerySequences(span.data, span.rawStartSeq, previous)
    this.scanState = scan.state
    const currentOwner = readForegroundProcess(this.reader)
    for (const query of scan.queries) {
      const kind = expectedReplyKind(query.data)
      if (!kind) {
        continue
      }
      const owner = query.startSeq < span.rawStartSeq ? this.pendingOwner : currentOwner
      this.value = owner
      // Reply grammars carry no request id. Once a different foreground owner asks
      // the same question, an older unanswered query cannot be correlated safely.
      for (let index = this.outstanding.length - 1; index >= 0; index -= 1) {
        const outstanding = this.outstanding[index]
        if (outstanding?.kind === kind && outstanding.owner !== owner) {
          this.outstanding.splice(index, 1)
        }
      }
      this.outstanding.push({ kind, owner })
      if (this.outstanding.length > MAX_OUTSTANDING_QUERIES) {
        this.outstanding.shift()
      }
    }
    if (scan.state.pendingStartSeq !== previous.pendingStartSeq) {
      this.pendingOwner = scan.state.pending ? currentOwner : undefined
    }
  }

  claimReplyOwner(reply: string): TerminalQueryReplyOwnerClaim {
    const kind = classifyTerminalQueryReply(reply)
    if (!kind) {
      return { matched: false }
    }
    const index = this.outstanding.findIndex((query) => query.kind === kind)
    if (index === -1) {
      return { matched: false }
    }
    const [query] = this.outstanding.splice(index, 1)
    return query ? { matched: true, owner: query.owner } : { matched: false }
  }
}
