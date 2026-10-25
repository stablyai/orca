// Program Status Protocol (OSC 7501) wire grammar: a program reports idle/working/blocked/done/error
// for itself (root record) or for ids beneath it. Spec: https://www.superlogical.com/rex/docs/build/program-status

export const PROGRAM_STATUS_OSC_PREFIX = '\x1b]7501;'

/** Negotiate replies: probing programs change rendering (Claude drops title glyphs), so clients cannot answer for glyph-only hosts. */
export const PROGRAM_STATUS_RUNTIME_CAPABILITY = 'terminal.program-status.v1' as const

const PROGRAM_STATUS_STATES = ['idle', 'working', 'done', 'blocked', 'error'] as const
export type ProgramStatusState = (typeof PROGRAM_STATUS_STATES)[number]

const PROGRAM_STATUS_KINDS = ['permission', 'question', 'auth'] as const
export type ProgramStatusKind = (typeof PROGRAM_STATUS_KINDS)[number]

/** The only bytes a supporting terminal ever writes back. Explicit lists so a later-revision
 *  program can tell exactly which states and kinds this terminal accepts. */
export const PROGRAM_STATUS_QUERY_REPLY = `${PROGRAM_STATUS_OSC_PREFIX}?:states=${PROGRAM_STATUS_STATES.join(',')}:kinds=${PROGRAM_STATUS_KINDS.join(',')}\x1b\\`

/** Whole sequence cap, OSC through ST. */
export const PROGRAM_STATUS_MAX_SEQUENCE_BYTES = 4096
const MAX_KEY_BYTES = 16
const MAX_MSG_ENCODED = 2732
const MAX_MSG_DECODED = 2048
const MAX_TITLE_ENCODED = 256
const MAX_TITLE_DECODED = 192
const MAX_ID_LENGTH = 128
const MAX_ID_DEPTH = 8
const MAX_APP_BYTES = 32

export type ProgramStatusReport = {
  /** Null addresses the root record. */
  id: string | null
  state: ProgramStatusState | 'clear'
  kind?: ProgramStatusKind
  progress?: number
  app?: string
  title?: string
  msg?: string
}

export type ProgramStatusMessage =
  | { type: 'query' }
  | { type: 'report'; report: ProgramStatusReport }

const KEY_RE = /^[a-z]+$/
const VALUE_RE = /^[A-Za-z0-9_.,+/=-]*$/
const SEGMENT_RE = /^[A-Za-z0-9_.+-]{1,32}$/
const APP_RE = /^[A-Za-z0-9_.+-]+$/
const PROGRESS_RE = /^\d{1,3}$/
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/
// oxlint-disable-next-line no-control-regex -- the spec refuses decoded C0/DEL/C1 controls
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/

const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

export function isProgramStatusState(value: unknown): value is ProgramStatusState {
  return PROGRAM_STATUS_STATES.some((state) => state === value)
}

export function isProgramStatusKind(value: unknown): value is ProgramStatusKind {
  return PROGRAM_STATUS_KINDS.some((kind) => kind === value)
}

/** Approvals and questions belong to the running turn; a sign-in or unnamed block outlives it. */
export function isTurnScopedProgramStatusKind(kind: ProgramStatusKind | undefined): boolean {
  return kind === 'permission' || kind === 'question'
}

/** Live states: the only ones whose reports may carry `progress`. */
export function programStatusStateCarriesProgress(state: ProgramStatusState | 'clear'): boolean {
  return state === 'working' || state === 'blocked'
}

/** done/error outlive the program that reported them, so the user still finds the result. */
export function programStatusStateOutlivesProgram(state: ProgramStatusState): boolean {
  return state === 'done' || state === 'error'
}

export function isProgramStatusQueryBody(body: string): boolean {
  return body.trim() === '?'
}

function isValidId(id: string): boolean {
  if (id.length > MAX_ID_LENGTH) {
    return false
  }
  const segments = id.split('/')
  return segments.length <= MAX_ID_DEPTH && segments.every((segment) => SEGMENT_RE.test(segment))
}

/** Decoded single-line text, or null when the report must be discarded whole. */
function decodeText(encoded: string, maxEncoded: number, maxDecoded: number): string | null {
  // Why before decoding: the encoded cap bounds the work a hostile program can cause.
  if (encoded.length > maxEncoded || !BASE64_RE.test(encoded)) {
    return null
  }
  const unpadded = encoded.replace(/=+$/, '')
  if (unpadded.length % 4 === 1) {
    return null
  }
  let binary: string
  try {
    binary = atob(unpadded + '='.repeat((4 - (unpadded.length % 4)) % 4))
  } catch {
    return null
  }
  if (binary.length > maxDecoded) {
    return null
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  let text: string
  try {
    text = utf8Decoder.decode(bytes)
  } catch {
    return null
  }
  return CONTROL_RE.test(text) ? null : text
}

/** Parse the body between `OSC 7501;` and ST. Null means ignore (no state, bad id, over a limit). */
export function parseProgramStatusBody(body: string): ProgramStatusMessage | null {
  // Why: the scanner already caps bodies, but this is exported and must stay bounded on its own.
  if (body.length > PROGRAM_STATUS_MAX_SEQUENCE_BYTES) {
    return null
  }
  if (isProgramStatusQueryBody(body)) {
    return { type: 'query' }
  }
  const pairs = new Map<string, string>()
  const texts: Partial<Record<'msg' | 'title', string>> = {}
  for (const pair of body.split(':')) {
    const equals = pair.indexOf('=')
    if (equals === -1) {
      continue
    }
    const key = pair.slice(0, equals).trim()
    const value = pair.slice(equals + 1).trim()
    // Why per occurrence: a hard cap broken anywhere voids the report, even if a duplicate follows.
    if (
      key.length > MAX_KEY_BYTES ||
      (key === 'app' && value.length > MAX_APP_BYTES) ||
      (key === 'id' && !isValidId(value))
    ) {
      return null
    }
    // Malformed pairs are skipped; the rest of the report still applies.
    if (!KEY_RE.test(key) || !VALUE_RE.test(value)) {
      continue
    }
    if (key === 'msg' || key === 'title') {
      // Every occurrence is checked, so a later duplicate cannot launder an over-limit one.
      const [maxEncoded, maxDecoded] =
        key === 'msg' ? [MAX_MSG_ENCODED, MAX_MSG_DECODED] : [MAX_TITLE_ENCODED, MAX_TITLE_DECODED]
      const text = decodeText(value, maxEncoded, maxDecoded)
      if (text === null) {
        return null
      }
      texts[key] = text
      continue
    }
    pairs.set(key, value)
  }

  const state = pairs.get('state')
  if (state === undefined || (state !== 'clear' && !isProgramStatusState(state))) {
    return null
  }
  // Every id occurrence was validated above: a malformed id must not overwrite the root record.
  const rawId = pairs.get('id')
  const report: ProgramStatusReport = { id: rawId ?? null, state }

  const kind = pairs.get('kind')
  if (state === 'blocked' && kind !== undefined && isProgramStatusKind(kind)) {
    report.kind = kind
  }
  const progress = pairs.get('progress')
  if (programStatusStateCarriesProgress(state) && progress && PROGRESS_RE.test(progress)) {
    const value = Number.parseInt(progress, 10)
    if (value <= 100) {
      report.progress = value
    }
  }
  const app = pairs.get('app')
  if (app !== undefined && APP_RE.test(app)) {
    report.app = app
  }
  if (texts.msg) {
    report.msg = texts.msg
  }
  if (texts.title) {
    report.title = texts.title
  }
  return { type: 'report', report }
}
