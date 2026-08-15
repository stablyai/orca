import type { PtyIngressSourceSpan } from './pty-startup-ingress-contract'
import { isShellProcess } from './shell-process-detection'
import {
  EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE,
  scanTerminalReplyQuerySequences,
  type TerminalReplyQueryScanState
} from './terminal-reply-query-scan'
import { parseTerminalOscColorQuery } from './terminal-osc-color-reply'
import {
  classifyTerminalQueryReplyIdentity,
  type TerminalQueryReplyIdentity
} from './terminal-query-reply'

export type ForegroundProcessReader = () => string | null | undefined

/** POSIX tty foreground process-group id (tpgid); null when it cannot be read. */
export type ForegroundProcessToken = number | null | undefined
export type ForegroundProcessTokenReader = () => ForegroundProcessToken

export function readForegroundProcess(
  reader: ForegroundProcessReader | undefined
): string | null | undefined {
  try {
    return reader?.()
  } catch {
    return undefined
  }
}

export function readForegroundProcessToken(
  reader: ForegroundProcessTokenReader | undefined
): ForegroundProcessToken {
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

export function shouldInjectQueryReplyForOwnerWithToken(
  queryOwner: string | null | undefined,
  foregroundProcess: string | null | undefined,
  observedToken: ForegroundProcessToken,
  currentToken: ForegroundProcessToken
): boolean {
  if (!shouldInjectQueryReplyForOwner(queryOwner, foregroundProcess)) {
    return false
  }
  // Both tokens absent keeps the name-only fallback (tpgid could not be
  // established at either boundary). Once a token was observed, a missing or
  // different current token must deny: the same-name querier is gone and its
  // process group with it.
  if (observedToken === undefined || observedToken === null) {
    return currentToken === undefined || currentToken === null
  }
  return currentToken !== undefined && currentToken !== null && currentToken === observedToken
}

export function shouldInjectQueryReplyForOwnerFromProcessWithToken(
  queryOwner: string | null | undefined,
  reader: ForegroundProcessReader | undefined,
  observedToken: ForegroundProcessToken,
  tokenReader: ForegroundProcessTokenReader | undefined
): boolean {
  return shouldInjectQueryReplyForOwnerWithToken(
    queryOwner,
    readForegroundProcess(reader),
    observedToken,
    readForegroundProcessToken(tokenReader)
  )
}

const MAX_OUTSTANDING_QUERIES = 64

// Why 5s: reply grammars carry no request id, so a claim must outlive the slowest
// in-order reply while still expiring so a stale CPR claim cannot swallow a user's
// Shift-F3 long after the querier exited. Pruned lazily; no timers.
export const TERMINAL_QUERY_OUTSTANDING_TTL_MS = 5_000

type OutstandingQuery = {
  identities: TerminalQueryReplyIdentity[]
  owner: string | null | undefined
  token: ForegroundProcessToken
  observedAt: number
}

export type TerminalQueryReplyOwnerClaim =
  | { matched: false }
  | { matched: true; owner: string | null | undefined; token?: ForegroundProcessToken }

/** One or more reply identities a query is allowed to elicit; [] when none. */
function expectedReplyIdentities(query: string): TerminalQueryReplyIdentity[] {
  if (query === '\x1b[5n') {
    return ['dsr']
  }
  if (query === '\x1b[6n') {
    return ['cpr-standard']
  }
  if (query === '\x1b[?6n') {
    return ['cpr-private']
  }
  if (query === '\x1b[?996n') {
    return ['private-dsr']
  }
  if (query === '\x1b[14t') {
    return ['window-report-14']
  }
  if (query === '\x1b[16t') {
    return ['window-report-16']
  }
  if (query === '\x1b[18t') {
    return ['window-report-18']
  }
  if (query === '\x1b[?u') {
    return ['kitty-flags']
  }
  if (query === '\x1b[>q') {
    return ['dcs-xtversion']
  }
  if (query.startsWith('\x1b]')) {
    const parsed = parseTerminalOscColorQuery(query, 0)
    if (parsed.kind !== 'match') {
      return []
    }
    // OSC 10 `?;?` asks for both slots at once.
    return parsed.slots.map((slot) => (slot === 10 ? 'osc-10' : 'osc-11'))
  }
  if (query.startsWith('\x1bP')) {
    return ['dcs-decrqss']
  }
  if (query.endsWith('$p')) {
    // DECRPM echoes the query's mode parameter and private marker in the reply.
    const body = query.slice(2, -2)
    const privateMarker = body.startsWith('?')
    const parameters = (privateMarker ? body.slice(1) : body).split(';')
    return parameters.map(
      (parameter) =>
        `mode-report-${privateMarker ? 'private' : 'ansi'}-${parameter}` as TerminalQueryReplyIdentity
    )
  }
  if (query.endsWith('c')) {
    const prefix = query[2]
    if (prefix === '>') {
      return ['device-attributes-2']
    }
    if (prefix === '=') {
      return ['device-attributes-3']
    }
    return ['device-attributes-1']
  }
  return []
}

/** Remembers each reply-eliciting query and the foreground process that emitted it. */
export class TerminalQueryOwnerTracker {
  private scanState: TerminalReplyQueryScanState = EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
  private pendingOwner: string | null | undefined
  private pendingToken: ForegroundProcessToken = undefined
  private value: string | null | undefined
  private readonly outstanding: OutstandingQuery[] = []

  constructor(
    private readonly reader: ForegroundProcessReader | undefined,
    private readonly tokenReader?: ForegroundProcessTokenReader
  ) {}

  get owner(): string | null | undefined {
    return this.value
  }

  accept(span: PtyIngressSourceSpan): void {
    this.pruneExpiredOutstanding()
    const previous = this.scanState
    const scan = scanTerminalReplyQuerySequences(span.data, span.rawStartSeq, previous)
    this.scanState = scan.state
    const currentOwner = readForegroundProcess(this.reader)
    // Why lazy: the token costs a `ps` subprocess, so it is only read when this
    // span actually captures a fresh query or opens a split, never per output
    // span. A split *completion* reuses the token captured at its start.
    let tokenRead = false
    let currentToken: ForegroundProcessToken = undefined
    for (const query of scan.queries) {
      const identities = expectedReplyIdentities(query.data)
      if (identities.length === 0) {
        continue
      }
      const split = query.startSeq < span.rawStartSeq
      if (!split && !tokenRead) {
        tokenRead = true
        currentToken = readForegroundProcessToken(this.tokenReader)
      }
      const owner = split ? this.pendingOwner : currentOwner
      const token = split ? this.pendingToken : currentToken
      this.value = owner
      // Reply grammars carry no request id, so only the selector a reply echoes
      // back (CPR marker, DA level, window number, DECRPM parameter, OSC slot,
      // DCS variant) can tie it to its query. A different owner asking an
      // overlapping selector retires that identity from older entries, while
      // unrelated identities of a multi-reply query (e.g. OSC 10 `?;?`) survive.
      for (const identity of identities) {
        for (let index = this.outstanding.length - 1; index >= 0; index -= 1) {
          const outstanding = this.outstanding[index]
          if (!outstanding || (outstanding.owner === owner && outstanding.token === token)) {
            continue
          }
          const identityIndex = outstanding.identities.indexOf(identity)
          if (identityIndex === -1) {
            continue
          }
          outstanding.identities.splice(identityIndex, 1)
          if (outstanding.identities.length === 0) {
            this.outstanding.splice(index, 1)
          }
        }
      }
      this.outstanding.push({ identities, owner, token, observedAt: Date.now() })
      if (this.outstanding.length > MAX_OUTSTANDING_QUERIES) {
        this.outstanding.shift()
      }
    }
    if (scan.state.pendingStartSeq !== previous.pendingStartSeq) {
      if (scan.state.pending) {
        this.pendingOwner = currentOwner
        this.pendingToken = readForegroundProcessToken(this.tokenReader)
      } else {
        this.pendingOwner = undefined
        this.pendingToken = undefined
      }
    }
  }

  claimReplyOwner(reply: string): TerminalQueryReplyOwnerClaim {
    this.pruneExpiredOutstanding()
    const identity = classifyTerminalQueryReplyIdentity(reply)
    if (!identity) {
      return { matched: false }
    }
    const index = this.outstanding.findIndex((query) => query.identities.includes(identity))
    if (index === -1) {
      return { matched: false }
    }
    const outstanding = this.outstanding[index]
    if (!outstanding) {
      return { matched: false }
    }
    // Claim exactly one identity; an entry dies only once every identity of a
    // multi-reply query (e.g. OSC 10 `?;?`) has been claimed.
    outstanding.identities.splice(outstanding.identities.indexOf(identity), 1)
    if (outstanding.identities.length === 0) {
      this.outstanding.splice(index, 1)
    }
    return outstanding.token === undefined
      ? { matched: true, owner: outstanding.owner }
      : { matched: true, owner: outstanding.owner, token: outstanding.token }
  }

  private pruneExpiredOutstanding(): void {
    const now = Date.now()
    for (let index = this.outstanding.length - 1; index >= 0; index -= 1) {
      const outstanding = this.outstanding[index]
      if (outstanding && now - outstanding.observedAt > TERMINAL_QUERY_OUTSTANDING_TTL_MS) {
        this.outstanding.splice(index, 1)
      }
    }
  }
}
