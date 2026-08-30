import type {
  CrashReportBreadcrumb,
  CrashReportBreadcrumbInput,
  CrashReportDetailValue
} from './crash-reporting'

const MAX_STRING_DETAIL_LENGTH = 240
const MAX_STACK_DETAIL_LENGTH = 4_000
const MAX_BREADCRUMB_NAME_LENGTH = 80
const MAX_BREADCRUMBS = 30

const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g
]
const CREDENTIAL_URL_PATTERN = /\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]+@(?=[^/\s]+)/g
const SECRET_ASSIGNMENT_PATTERN =
  /\b(token|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|secret|password|account[_-]?key)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^&\s,;]+)/gi

// Characters that end an unquoted path token.
const PATH_STOP = '\\s"\'`<>)'
// A crossing looks ahead over a bounded window. Unbounded, it re-read the rest of the line at every
// space, so one long line cost a second to sanitise. The run bound is a filesystem's longest
// segment; without it a single long run carrying many separators costs as much on its own.
const MAX_CROSSED_RUNS = 2
const MAX_RUN_LENGTH = 255
// An extension is as long as its format made it -- '.entitlements', '.mobileprovision' -- so a
// length bound here ends a path at the last name it still recognised. The run bound caps the reach.
const EXTENSION = '\\.[A-Za-z0-9]+'

// What may follow a space and still be the same path. No run in the window starts with the separator
// (so a second path on the same line stays a second path) and none carries ':' (so two stack frames
// do not collapse into one). Beyond that the window must reach a run that is path evidence by
// itself, because nothing else separates a path's spaced segments from the prose that follows one:
//   'Very Private Share\\creds.txt' -- a run carrying a separator and a name, or a separator twice
//     ('Team Share\\orca\\workspace'), is a segment chain, so plain runs may precede it. 'but
//     read/write failed' reaches neither and is left alone.
//   'My Notes.txt' -- a spaced last segment is only a name, so every run before it has to carry a
//     separator. 'then push git@github.com' does not, which stops a host from reading as a file.
const pathContinuation = (separator: string, crossableRuns: number): string => {
  const body = `[^${PATH_STOP}:]{0,${MAX_RUN_LENGTH}}`
  const run = `[^${PATH_STOP}:${separator}]${body}`
  const chainRun = `${run}${separator}${body}`
  const name = `${EXTENSION}(?![^${PATH_STOP}:])`
  const crossed = (crossable: string): string => `(?:${crossable}[ \\t]){0,${crossableRuns}}`
  return (
    `(?:${crossed(run)}(?:${chainRun}${name}|${chainRun}${separator}${body})` +
    `|${crossed(chainRun)}${run}${name})`
  )
}

// Quoted paths keep their spaces. An unquoted path crosses a space only to reach a run that
// continues it, which keeps emitting the marker and removing the path a single operation rather
// than two. A run ending in a name ends the path -- a filename is the last thing in one -- and
// sentence punctuation ends it too, so the prose after a path survives.
// A name only ends a path where the path does not visibly resume. A dot sits inside folder names
// too -- 'Release 1.0 Notes/spec.md' -- and there it is no filename, so after a name the crossing
// still reaches the very next run. It reaches no further: a path has no filler words between its
// segments, which is what 'creds.txt then check b/c/d.txt' has and what leaves that prose alone.
const unquotedPathTail = (separator: string): string =>
  `(?:[^${PATH_STOP}]|(?<![.,;:!?])(?:(?<!${EXTENSION})[ \\t](?=${pathContinuation(separator, MAX_CROSSED_RUNS)})` +
  `|[ \\t](?=${pathContinuation(separator, 0)})))*`
const POSIX_TAIL = unquotedPathTail('/')
const WINDOWS_TAIL = unquotedPathTail('\\\\')

// A local path also reaches a report wearing a URL: renderer stacks are `file://` throughout, and a
// deep link (`vscode://file/...`), a share URL, or a drive spelled `C:/...` carries one too. The bare
// patterns cannot see any of them -- the root `/` sits behind a scheme, which their lookbehind
// rejects. Matching from the scheme removes it with the path, so no root is left beside the marker,
// and the scheme is proof enough of a path that no plain first segment is needed. The web transports
// are excluded: their path names a remote resource, not this machine's disk.
// A scheme can also be stacked on another, as a database URL stacks one on its driver. The stack is
// matched with the path, because starting inside it left `jdbc:` standing beside the marker. The
// lookbehind still admits what is no scheme at all before it -- 'at line 12:file:///...',
// '1.2.3-file:///...' -- so a path behind punctuation is not left whole. It keeps rejecting a word
// character, which is what stops the tail of an excluded scheme ('ttps:/') from matching on its own.
const MAX_STACKED_SCHEMES = 3
const LOCAL_URL_ROOT =
  `(?<![A-Za-z0-9])(?:[A-Za-z][A-Za-z0-9+.-]*:){0,${MAX_STACKED_SCHEMES}}?` +
  '(?!(?:https?|wss?):)[A-Za-z][A-Za-z0-9+.-]*:/'

const PATH_PATTERNS = [
  /(["'`])\/[A-Za-z0-9._-]+\/(?:(?!\1)[^<>\n\r])+\1/g,
  /(["'`])[A-Za-z]:\\(?:(?!\1)[^<>\n\r])+\1/gi,
  /(["'`])\\\\[^\\\s"'`<>\n\r)]+\\(?:(?!\1)[^<>\n\r])+\1/gi,
  new RegExp(`${LOCAL_URL_ROOT}${POSIX_TAIL}`, 'gi'),
  new RegExp(`(?<![A-Za-z0-9./~])~[A-Za-z0-9._-]*/[A-Za-z0-9._-]+/${POSIX_TAIL}`, 'g'),
  new RegExp(`(?<![A-Za-z0-9./])/[A-Za-z0-9._-]+/${POSIX_TAIL}`, 'g'),
  new RegExp(`(?<![A-Za-z0-9])[A-Za-z]:\\\\${WINDOWS_TAIL}`, 'gi'),
  new RegExp(`\\\\\\\\[^\\\\${PATH_STOP}]+\\\\${WINDOWS_TAIL}`, 'gi'),
  new RegExp(`%(?:USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH)%${WINDOWS_TAIL}`, 'gi')
]

export function sanitizeCrashReportString(
  value: string,
  maxLength = MAX_STRING_DETAIL_LENGTH
): string {
  let sanitized = value
  for (const pattern of PATH_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[redacted-path]')
  }
  sanitized = sanitized.replace(CREDENTIAL_URL_PATTERN, '[redacted-credential]@')
  sanitized = sanitized.replace(SECRET_ASSIGNMENT_PATTERN, (_match, key: string) => {
    return `${key}=[redacted]`
  })
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[redacted-secret]')
  }
  return sanitized.length > maxLength ? `${sanitized.slice(0, maxLength)}...` : sanitized
}

export function sanitizeCrashReportDetails(
  details: Record<string, unknown>
): Record<string, CrashReportDetailValue> {
  const sanitized: Record<string, CrashReportDetailValue> = {}
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === 'string') {
      const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      if (/(?:^|_)path$/i.test(normalizedKey)) {
        sanitized[key] = '[redacted-path]'
      } else {
        const maxLength =
          /(?:^|_)(?:stack|component_stack|error_stack|minidump_check_message)$/i.test(
            normalizedKey
          )
            ? MAX_STACK_DETAIL_LENGTH
            : MAX_STRING_DETAIL_LENGTH
        sanitized[key] = sanitizeCrashReportString(value, maxLength)
      }
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      sanitized[key] = value
    } else if (typeof value === 'boolean' || value === null) {
      sanitized[key] = value
    }
  }
  return sanitized
}

export function sanitizeCrashReportBreadcrumbs(
  breadcrumbs: CrashReportBreadcrumbInput[] | undefined
): CrashReportBreadcrumb[] | undefined {
  if (!breadcrumbs || breadcrumbs.length === 0) {
    return undefined
  }

  const sanitized = breadcrumbs
    .slice(-MAX_BREADCRUMBS)
    .map((breadcrumb): CrashReportBreadcrumb | null => {
      if (!breadcrumb.name.trim() || !breadcrumb.createdAt.trim()) {
        return null
      }
      const data = breadcrumb.data ? sanitizeCrashReportDetails(breadcrumb.data) : {}
      const origin = breadcrumb.origin
        ? sanitizeCrashReportString(breadcrumb.origin).slice(0, 80)
        : ''
      return {
        createdAt: sanitizeCrashReportString(breadcrumb.createdAt),
        name: sanitizeCrashReportString(breadcrumb.name).slice(0, MAX_BREADCRUMB_NAME_LENGTH),
        ...(Object.keys(data).length > 0 ? { data } : {}),
        ...(origin ? { origin } : {})
      }
    })
    .filter((breadcrumb): breadcrumb is CrashReportBreadcrumb => breadcrumb !== null)

  return sanitized.length > 0 ? sanitized : undefined
}
