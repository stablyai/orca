import type { GitStashEntry } from './git-stash-types'

/**
 * Frozen so main, the relay, and the SSH provider cannot drift into parsing one
 * format while requesting another.
 *
 * Why this shape: `git stash list <args>` appends args after git's own
 * `log --format='%gd: %gs' -g --first-parent`, so a later `--format` wins.
 * Separator and terminator are both NUL because stash subjects legitimately
 * contain colons ("WIP on main: dcd7952 init: base"), and every flag here
 * predates the Git 2.25 baseline.
 */
export const GIT_STASH_LIST_ARGS: readonly string[] = Object.freeze([
  'stash',
  'list',
  '-z',
  '--format=%gd%x00%H%x00%ct%x00%gs'
])

const FIELDS_PER_ENTRY = 4

/**
 * Parse the NUL-delimited stash listing into entries, skipping records git
 * couldn't fill in completely.
 *
 * Fixed arity — not "split records, then split fields" — is what makes this
 * unambiguous when the separator and terminator are the same byte. It also
 * degrades correctly on a git that ignores `-z`: the subject then arrives with a
 * trailing newline, which `trimSubject` removes.
 */
export function parseGitStashList(stdout: string): GitStashEntry[] {
  const tokens = stdout.split('\0')
  // Why: git NUL-terminates rather than NUL-separates, so the tail is empty.
  if (tokens.at(-1) === '') {
    tokens.pop()
  }

  const entries: GitStashEntry[] = []
  // Why: a truncated trailing record (killed subprocess, maxBuffer cut) must be
  // dropped rather than parsed into an entry with empty fields.
  for (let start = 0; start + FIELDS_PER_ENTRY <= tokens.length; start += FIELDS_PER_ENTRY) {
    const entry = buildStashEntry(
      trimSubject(tokens[start]),
      tokens[start + 1],
      tokens[start + 2],
      trimSubject(tokens[start + 3])
    )
    if (entry) {
      entries.push(entry)
    }
  }
  return entries
}

function buildStashEntry(
  ref: string,
  commitOid: string,
  createdAt: string,
  subject: string
): GitStashEntry | null {
  const index = parseStashRefIndex(ref)
  if (index === null || !/^[0-9a-f]{7,64}$/.test(commitOid)) {
    return null
  }
  const createdAtSeconds = /^\d+$/.test(createdAt) ? Number.parseInt(createdAt, 10) : 0
  return {
    ref,
    index,
    commitOid,
    createdAtSeconds: Number.isSafeInteger(createdAtSeconds) ? createdAtSeconds : 0,
    subject
  }
}

/** `stash@{3}` -> 3. Null for anything that isn't git's own stash ref shape. */
export function parseStashRefIndex(ref: string): number | null {
  const match = /^stash@\{(\d+)\}$/.exec(ref)
  if (!match) {
    return null
  }
  const index = Number.parseInt(match[1], 10)
  return Number.isSafeInteger(index) ? index : null
}

// Why: tolerate a git that ignored `-z` (subject arrives newline-terminated) and
// Windows CRLF, without discarding legitimate interior whitespace.
function trimSubject(value: string): string {
  return value.replace(/^[\r\n]+/, '').replace(/[\r\n]+$/, '')
}
