import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every client-side reader of a send's raw dispatch facts once re-derived "is this send still
 * open, drawn as sent, or refused" on its own, and those copies disagreed with each other again
 * and again. `structuredAgentSessionSubmissionSettlement` decides it once; this fails on a new
 * raw read anywhere a client or the shared projection could grow another copy. The host's own
 * journal code (src/main) writes these facts and is out of scope.
 */
const ALLOWED: ReadonlyMap<string, string> = new Map([
  ['src/shared/structured-agent-session-submission-settlement.ts', 'the classifier itself'],
  [
    'src/shared/agent-session-queued-submission.ts',
    'queued is a pending the host has not handed over yet: a subset of open, read with handover facts'
  ],
  [
    'mobile/src/session/mobile-structured-send-operation-journal.ts',
    'clears an ack-lost operation id once the host has moved the send past pending, as mobile ' +
      'delivery spends the id on a live unknown; `open` deliberately joins those two'
  ]
])

const SCANNED_ROOTS = ['src/shared', 'src/renderer', 'mobile/src']
const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'out', 'build', '__fixtures__'])
const RAW_READ = [
  // Not a spread: `...recovered` is some other value's name.
  /(?<!\.)\.\s*(?:dispatchState|recovered)\b/,
  // `const { dispatchState } = submission`
  /\{[^{}]*\b(?:dispatchState|recovered)\b[^{}]*\}\s*=(?![=>])/
]

function isTestFile(path: string): boolean {
  return (
    /\.(?:test|spec)\.tsx?$/.test(path) ||
    /(?:test-harness|test-utils|test-setup|test-fixture)/.test(path) ||
    path.includes('/__tests__/')
  )
}

function collectSourceFiles(root: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  return entries.flatMap((entry) => {
    if (IGNORED_DIRECTORIES.has(entry)) {
      return []
    }
    const full = join(root, entry)
    if (statSync(full).isDirectory()) {
      return collectSourceFiles(full)
    }
    return /\.tsx?$/.test(full) ? [full] : []
  })
}

/** Drop comment-only lines so prose about the facts is not an offender. */
function codeText(contents: string): string {
  return contents
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n')
}

describe('submission settlement boundary', () => {
  const repoRoot = resolve(__dirname, '..', '..')
  const files = SCANNED_ROOTS.flatMap((root) => collectSourceFiles(join(repoRoot, root)))
    .map((file) => relative(repoRoot, file).split('\\').join('/'))
    .filter((path) => !isTestFile(path))
  const offenders = files.filter((path) => {
    const code = codeText(readFileSync(join(repoRoot, path), 'utf8'))
    return RAW_READ.some((pattern) => pattern.test(code))
  })

  it('scans a plausible number of files', () => {
    // A broken root would make the guard silently vacuous.
    expect(files.length).toBeGreaterThan(1000)
    expect(files.some((path) => path.startsWith('mobile/src/'))).toBe(true)
  })

  it('reads dispatch facts only through the settlement classifier', () => {
    expect(
      offenders.filter((path) => !ALLOWED.has(path)),
      "Raw read of a submission's dispatchState/recovered. Branch on " +
        'structuredAgentSessionSubmissionSettlement instead.'
    ).toEqual([])
  })

  it('has no stale exception', () => {
    expect([...ALLOWED.keys()].filter((path) => !offenders.includes(path))).toEqual([])
  })
})
