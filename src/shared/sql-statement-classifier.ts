// Heuristic SQL classification. Two distinct, non-security uses:
//   - isCursorableRead: pick the bounded-cursor execution path (main process).
//   - needsWriteConfirm: drive the confirm dialog for WRITABLE connections
//     (renderer). Conservative — anything not clearly a pure read confirms.
//
// Neither is a security boundary: read-only connections are enforced by a
// database read-only transaction (see the drivers), not by these checks.

// Strip comments and blank single-quoted string-literal contents so keyword and
// statement-separator detection isn't fooled by commented-out text or by words/
// semicolons inside literals (e.g. `WHERE action = 'DELETE; DROP'`).
function sanitize(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
}

// True when, after trimming trailing separators, another statement separator
// remains — i.e. the input is multiple statements. Semicolons inside string
// literals are ignored (conservative: would over-detect, never under-detect).
function isMultiStatement(body: string): boolean {
  const trimmed = body.replace(/;\s*$/, '').trim()
  return trimmed.includes(';')
}

function firstKeyword(body: string): string {
  return body.trim().split(/\s+/, 1)[0]?.toUpperCase() ?? ''
}

// Statements safe to run through a bounded cursor (they return rows and are
// valid as a Postgres DECLARE CURSOR query).
const CURSORABLE_KEYWORDS = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE'])

// Single-statement, unambiguously read-only openers — no confirm needed.
const PURE_READ_KEYWORDS = new Set([
  'SELECT',
  'SHOW',
  'EXPLAIN',
  'DESCRIBE',
  'DESC',
  'VALUES',
  'TABLE'
])

// Keywords that mutate data or schema anywhere in the statement.
const WRITE_KEYWORD_RE =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|MERGE|REPLACE|CALL|EXEC|EXECUTE|COMMENT|VACUUM|COPY|LOCK|SET|RESET|BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b/i

export function isCursorableRead(sql: string): boolean {
  const body = sanitize(sql)
  if (isMultiStatement(body)) {
    return false
  }
  return CURSORABLE_KEYWORDS.has(firstKeyword(body))
}

// Conservative: only skip the confirm dialog for a single-statement pure read
// with no write keyword anywhere (so a writing CTE like `WITH x AS (DELETE …)`
// still confirms). Everything else — writes, multi-statement, WITH, unknown —
// requires confirmation.
export function needsWriteConfirm(sql: string): boolean {
  const body = sanitize(sql)
  if (!body.trim()) {
    return false
  }
  if (isMultiStatement(body)) {
    return true
  }
  if (!PURE_READ_KEYWORDS.has(firstKeyword(body))) {
    return true
  }
  return WRITE_KEYWORD_RE.test(body)
}
