/**
 * Classifies one line of agent CLI output as an auth or network failure.
 *
 * Why bytes and not a status: agent hooks carry no failure cause, so a turn that
 * died on an expired token looks exactly like one that finished. Provider-neutral
 * by construction — every pattern is phrasing shared by the CLIs and the HTTP/DNS
 * stacks under them, so a new agent needs no table entry.
 */

export type AgentStallCause = 'auth' | 'network' | 'rate-limit'

export type AgentStallSignature = {
  cause: AgentStallCause
  /** The matched text, for the recovery UI. Bounded — never a whole line. */
  signature: string
}

/** Longest signature echoed back to the UI. */
export const AGENT_STALL_SIGNATURE_MAX_CHARS = 120

/** Failures a restart cannot fix, matched first so a line that also mentions a
 *  token or a connection can never read as recoverable. A spent quota that only
 *  a payment reopens stays here; a limit that resets on a clock does not — that
 *  is the 'rate-limit' cause, held until Orca's rate-limit subsystem says the
 *  window reopened. */
const UNRECOVERABLE_PATTERNS: readonly RegExp[] = [
  /\bcredit balance is too low\b/i,
  /\binsufficient (?:credit|quota|funds)\b/i,
  /\byour (?:plan|subscription) (?:does not|doesn't) (?:include|support)\b/i,
  /\b(?:invalid|unknown|unsupported) model\b/i,
  /\bmodel (?:not found|is not available)\b/i,
  /\bcontext (?:window )?(?:limit )?exceeded\b/i,
  /\bprompt is too long\b/i,
  /\brequest (?:too large|entity too large)\b/i,
  /\b(?:permission|access) denied\b/i,
  /\bEACCES\b/,
  /\bENOENT\b/,
  /\bcommand not found\b/i
]

/** Matches that stand on their own — the phrasing is not used for anything else. */
const UNAMBIGUOUS_PATTERNS: readonly { cause: AgentStallCause; pattern: RegExp }[] = [
  // Auth
  { cause: 'auth', pattern: /\binvalid[- ]api[- ]key\b/i },
  { cause: 'auth', pattern: /\bapi key (?:is )?(?:invalid|expired|missing|not valid)\b/i },
  { cause: 'auth', pattern: /\bauthentication_error\b/i },
  { cause: 'auth', pattern: /\binvalid_(?:token|grant|client)\b/i },
  { cause: 'auth', pattern: /\b(?:oauth |access |refresh |bearer )?token (?:has )?expired\b/i },
  { cause: 'auth', pattern: /\b(?:credentials?|session|login) (?:has |have )?expired\b/i },
  { cause: 'auth', pattern: /\byou(?:'re| are)? not logged in\b/i },
  { cause: 'auth', pattern: /\blogin (?:required|expired)\b/i },
  { cause: 'auth', pattern: /\bplease (?:run|use) [`'"]?(?:\/login|[a-z-]+ login)\b/i },
  { cause: 'auth', pattern: /\brun [`'"]?\/login\b/i },
  { cause: 'auth', pattern: /\bre-?authenticat(?:e|ion required)\b/i },
  { cause: 'auth', pattern: /\bsign in (?:again|to continue)\b/i },
  { cause: 'auth', pattern: /\b401\b[^\n]{0,40}\bunauthorized\b/i },
  { cause: 'auth', pattern: /\bunauthorized\b[^\n]{0,40}\b401\b/i },
  // The signed-in account moved out from under a running agent — same remedy as
  // an expired token, different phrasing, and no error vocabulary of its own.
  {
    cause: 'auth',
    pattern: /\bsigned[- ]in\b[^\n]{0,60}\baccount (?:or organization )?changed\b/i
  },
  { cause: 'auth', pattern: /\/login\b[^\n]{0,40}\bto switch back\b/i },
  // Rate limit: user-facing phrasing only. The bare words stay contextual below,
  // so an agent discussing rate limits in prose is not a stall.
  {
    cause: 'rate-limit',
    pattern: /\byou'?(?:ve| have) hit your (?:session|usage|weekly|daily) limit\b/i
  },
  { cause: 'rate-limit', pattern: /\busage limit reached\b/i },
  { cause: 'rate-limit', pattern: /\bquota exceeded\b/i },
  { cause: 'rate-limit', pattern: /\b(?:session|usage|weekly|daily) limit reached\b/i },
  // Network
  { cause: 'network', pattern: /\bconnection error\b/i },
  { cause: 'network', pattern: /\bfetch failed\b/i },
  { cause: 'network', pattern: /\bsocket hang up\b/i },
  { cause: 'network', pattern: /\bconnection (?:reset by peer|refused|aborted)\b/i },
  { cause: 'network', pattern: /\b(?:network|internet) is unreachable\b/i },
  { cause: 'network', pattern: /\bupstream connect error\b/i },
  { cause: 'network', pattern: /\btls handshake (?:timeout|failure)\b/i },
  { cause: 'network', pattern: /\bgetaddrinfo\b/i },
  { cause: 'network', pattern: /\boverloaded_error\b/i },
  { cause: 'network', pattern: /\bapi error\b[^\n]{0,20}\b5\d\d\b/i },
  { cause: 'network', pattern: /\b(?:502 bad gateway|503 service unavailable|504 gateway)\b/i },
  {
    cause: 'network',
    pattern:
      /\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|ENETDOWN|EHOSTUNREACH|EPROTO|UND_ERR_(?:CONNECT_TIMEOUT|SOCKET|HEADERS_TIMEOUT))\b/
  }
]

/** Without this gate an agent narrating its plan ("I'll add a timeout to the
 *  network client") reads as a stall. */
const ERROR_CONTEXT_PATTERN =
  /\b(?:error|errno|failed|failure|fatal|cannot|can't|could ?n(?:o|')t|unable to|refused|unreachable|aborted|retrying|giving up)\b/i

const CONTEXTUAL_PATTERNS: readonly { cause: AgentStallCause; pattern: RegExp }[] = [
  { cause: 'auth', pattern: /\bauthenticat(?:e|ion|ing)\b/i },
  { cause: 'auth', pattern: /\bunauthenticated\b/i },
  { cause: 'auth', pattern: /\bunauthorized\b/i },
  { cause: 'auth', pattern: /\bcredentials?\b/i },
  { cause: 'network', pattern: /\bnetwork\b/i },
  { cause: 'network', pattern: /\bconnect(?:ion|ing)?\b/i },
  { cause: 'network', pattern: /\btimed? ?out\b/i },
  { cause: 'network', pattern: /\bdns\b/i },
  { cause: 'network', pattern: /\bproxy\b/i },
  { cause: 'network', pattern: /\boffline\b/i },
  // `rate_limit_error` is the API's own code; 429 is the status that carries it.
  { cause: 'rate-limit', pattern: /\brate[-_ ]?limit(?:ed|s|_error)?\b/i },
  { cause: 'rate-limit', pattern: /\b429\b/ }
]

/** Lines that quote rather than report — diff hunks, echoes, grep hits. The
 *  largest false-positive source: an agent *fixing* error-handling code. */
const QUOTED_LINE_PATTERN =
  /^\s*(?:[+-]{1,3}[^-]|[>|]|\d+[:|]|@@ )|(?:\becho\b|\bgrep\b|\bconsole\.(?:log|warn|error)\b|\bthrow new\b|\bcatch\b|`{3})/

/** One cheap test every real match must also pass, so ordinary output costs a
 *  single regex rather than walking the tables. This is on the PTY byte path. */
const CANDIDATE_PATTERN =
  // No leading \b: this only has to be *cheap* and never miss, so `overloaded_error`
  // and other embedded forms must match too. Precision belongs to the tables above.
  /(?:err(?:or|no)|fail(?:ed|ure)?|fatal|unauthoriz|unauthenticat|authenticat|credential|token|api[- ]key|login|log in|sign in|connect|network|timeout|timed out|dns|proxy|offline|socket|fetch|refused|unreachable|expired|getaddrinfo|limit|quota|E[A-Z_]{4,}|UND_ERR|401|4\d\d|5\d\d)/i

function truncateSignature(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > AGENT_STALL_SIGNATURE_MAX_CHARS
    ? `${collapsed.slice(0, AGENT_STALL_SIGNATURE_MAX_CHARS - 1)}…`
    : collapsed
}

/** Defaults to "not a stall": a false positive interrupts a healthy agent. */
export function classifyAgentStallLine(line: string): AgentStallSignature | null {
  if (line.length < 4 || line.length > 4000) {
    return null
  }
  if (!CANDIDATE_PATTERN.test(line)) {
    return null
  }
  if (QUOTED_LINE_PATTERN.test(line)) {
    return null
  }
  for (const pattern of UNRECOVERABLE_PATTERNS) {
    if (pattern.test(line)) {
      return null
    }
  }
  for (const { cause, pattern } of UNAMBIGUOUS_PATTERNS) {
    const match = pattern.exec(line)
    if (match) {
      return { cause, signature: truncateSignature(match[0]) }
    }
  }
  if (!ERROR_CONTEXT_PATTERN.test(line)) {
    return null
  }
  for (const { cause, pattern } of CONTEXTUAL_PATTERNS) {
    if (pattern.test(line)) {
      return { cause, signature: truncateSignature(line) }
    }
  }
  return null
}
