import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runProcessSync } from './child-process/run-process'
import { windowsSystem32Binary } from './child-process/windows-system-binary'
import {
  setSecurePathHardeningReporter,
  type SecurePathHardeningReport
} from './secure-path-hardening-report'
import {
  bestEffortRestrictWindowsPath,
  resetSecureFileWindowsUserSidForTests,
  restrictWindowsPathSync
} from './secure-path-windows-acl'
import { removeTreeSync } from './windows-transient-lock-removal'

/**
 * The half of the proof a mocked argv test cannot give.
 *
 * The shipped bug was not a wrong argv — it was an argv the *callee* never
 * received: `powershell.exe -Command <script> <path> <sid>` leaves `$args`
 * empty, so the script died on its first statement and every caller was told
 * the path had been hardened. Asserting on the constructed arguments passed
 * happily throughout. Only reading the resulting ACL back off a real file
 * catches it, so that is what this does.
 *
 * Runs only on win32; skipped elsewhere.
 */
const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

const EVERYONE_SID = 'S-1-1-0'
const BUILTIN_ADMINISTRATORS_SID = 'S-1-5-32-544'
/** High, System and Protected mandatory levels: the token is elevated. Medium (S-1-16-8192) is not. */
const ELEVATED_INTEGRITY_SID = /\bS-1-16-(?:12288|16384|20480)\b/

/** The SID the production code will grant to, so a planted DACL can differ only in its flags. */
function currentUserSid(): string {
  const result = runProcessSync({
    program: windowsSystem32Binary('whoami.exe'),
    args: ['/user', '/fo', 'csv', '/nh'],
    timeoutMs: 10_000
  })
  return result.stdout.trim().split(/","/)[1]!.replace(/"$/, '')
}

/**
 * Plants an exact DACL. Two invocations on purpose: combining `/inheritance:r` with `/grant:r`
 * leaves the argument order to icacls, and on Windows Server the inherited ACEs survive the
 * combined form as explicit ones -- which is a planted precondition that silently is not the
 * one written down. Removing inheritance first makes the grant the whole DACL.
 */
function plantDacl(path: string, grants: string[]): void {
  expect(icacls(path, '/inheritance:r', '/q').code).toBe(0)
  expect(icacls(path, ...grants.flatMap((grant) => ['/grant:r', grant]), '/q').code).toBe(0)
}

function icacls(...args: string[]): { code: number | null; stdout: string } {
  const result = runProcessSync({
    program: windowsSystem32Binary('icacls.exe'),
    args,
    timeoutMs: 10_000
  })
  return { code: result.code, stdout: result.stdout }
}

/**
 * Whether this process could rewrite a system file's DACL — decided before anything is written.
 *
 * `icacls <hosts> /save` is not the probe it looks like: `BUILTIN\Users` holds `(RX)`, so
 * READ_CONTROL succeeds unelevated and every machine would report elevated. The token's mandatory
 * integrity level is the thing that actually differs, and it is a SID rather than a localized
 * string, so it reads the same on a non-English Windows.
 */
function isElevated(): boolean {
  if (process.platform !== 'win32') {
    return false
  }
  const result = runProcessSync({
    program: windowsSystem32Binary('whoami.exe'),
    args: ['/groups', '/fo', 'csv', '/nh'],
    timeoutMs: 10_000
  })
  if (ELEVATED_INTEGRITY_SID.test(result.stdout)) {
    return true
  }
  // Unelevated, Administrators is present only as "Group used for deny only".
  const administrators = result.stdout
    .split(/\r?\n/)
    .find((line) => line.includes(BUILTIN_ADMINISTRATORS_SID))
  return administrators?.includes('Enabled group') ?? false
}

/**
 * The `Principal:(flags)` entries of `icacls <path>`. The first line carries the path, which is
 * stripped by the exact string passed in so its own spaces cannot be mistaken for the separator.
 */
function readAclEntries(path: string): string[] {
  const arg = path.length < 260 ? path : `\\\\?\\${path}`
  const { stdout } = icacls(arg)
  const entries: string[] = []
  for (const [index, rawLine] of stdout.split(/\r?\n/).entries()) {
    const line = index === 0 ? rawLine.slice(arg.length) : rawLine
    const trimmed = line.trim()
    if (!trimmed && index > 0) {
      break
    }
    if (trimmed.includes(':(')) {
      entries.push(trimmed)
    }
  }
  return entries
}

/**
 * `toHaveLength` reports only the count, and vitest elides the array past a few items — which on a
 * host that lists a DACL differently is exactly the information needed. Name the entries.
 */
function listed(entries: string[]): string {
  return `icacls listed ${entries.length} entries: ${entries.join(' | ')}`
}

describeOnWindows('restrictWindowsPathSync against a real filesystem', () => {
  const elevated = isElevated()
  let root: string

  beforeAll(() => {
    resetSecureFileWindowsUserSidForTests()
    root = mkdtempSync(join(tmpdir(), 'orca-acl-win32-'))
    // %TEMP% grants [user, SYSTEM, Administrators] (OI)(CI)(F) by default, and those
    // propagate into every fixture below. Strip them here so a planted DACL is exactly what
    // the test planted: on a host where the running user is also one of the three principals
    // a test grants, an inherited copy is otherwise indistinguishable from a planted one.
    plantDacl(root, [`*${currentUserSid()}:(OI)(CI)(F)`])
  })

  afterAll(() => {
    // This suite plants hostile DACLs on purpose, and `removeTreeSync` only retries *transient*
    // locks. Should a repair regress, an `(OI)(CI)(IO)` grant leaves the tree permanently
    // undeletable — so restore inheritance first rather than leaking it into %TEMP% every run.
    icacls(root, '/reset', '/t', '/q')
    removeTreeSync(root)
  })

  it('actually applies the ACL to a real file, dropping inherited and foreign ACEs', () => {
    const file = join(root, 'credential.json')
    writeFileSync(file, '{"token":"secret"}')
    // A planted explicit ACE: /inheritance:r alone does not remove these.
    expect(icacls(file, '/grant', `*${EVERYONE_SID}:(R)`).code).toBe(0)

    const before = readAclEntries(file)
    expect(before.some((entry) => entry.startsWith('Everyone:'))).toBe(true)
    expect(before.some((entry) => entry.includes('(I)'))).toBe(true)

    expect(restrictWindowsPathSync(file, false)).toBe(true)

    const after = readAclEntries(file)
    // No inherited ACE survives: the DACL is protected.
    expect(after.every((entry) => !entry.includes('(I)'))).toBe(true)
    expect(after.some((entry) => entry.startsWith('Everyone:'))).toBe(false)
    // Exactly the three intended principals, each with FullControl.
    expect(after).toHaveLength(3)
    expect(after.every((entry) => entry.endsWith(':(F)'))).toBe(true)
  })

  it('gives a real directory inheritable rules so files created inside stay restricted', () => {
    const dir = join(root, 'secure-dir')
    mkdirSync(dir)

    expect(restrictWindowsPathSync(dir, true)).toBe(true)

    const after = readAclEntries(dir)
    expect(after).toHaveLength(3)
    expect(after.every((entry) => entry.endsWith(':(OI)(CI)(F)'))).toBe(true)
    expect(after.every((entry) => !entry.includes('(I)'))).toBe(true)

    // The point of the inheritance flags: a child written afterwards is already restricted.
    const child = join(dir, 'inherited.json')
    writeFileSync(child, '{}')
    const childEntries = readAclEntries(child)
    expect(childEntries).toHaveLength(3)
    expect(childEntries.every((entry) => entry.includes('(I)'))).toBe(true)
    expect(childEntries.some((entry) => entry.startsWith('Everyone:'))).toBe(false)
  })

  // Paths reach this code from user-chosen workspace locations, so the quoting hazards that
  // ruled out interpolating them into a PowerShell command line get exercised for real.
  it.each([
    ['spaces', 'a b c'],
    ['single quote and dollar', "quo'te $var"],
    ['backtick', 'back`tick'],
    ['brackets', 'brack[et]s'],
    ['semicolon and ampersand', 'semi;colon & amp'],
    ['comma', 'com,ma'],
    ['parentheses', 'paren(s)'],
    ['caret and percent', 'car^et %PATH%']
  ])('hardens a path containing %s', (_label, segment) => {
    const dir = join(root, segment)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'secret.json')
    writeFileSync(file, '{}')

    expect(restrictWindowsPathSync(file, false)).toBe(true)

    const after = readAclEntries(file)
    expect(after).toHaveLength(3)
    expect(after.every((entry) => !entry.includes('(I)'))).toBe(true)
  })

  it('hardens a path longer than MAX_PATH', () => {
    let dir = join(root, 'long')
    while (dir.length < 280) {
      dir = join(dir, 'x'.repeat(40))
    }
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'secret.json')
    expect(file.length).toBeGreaterThan(260)
    writeFileSync(file, '{}')

    expect(restrictWindowsPathSync(file, false)).toBe(true)
    expect(readAclEntries(file)).toHaveLength(3)
  })

  /**
   * The shape of a DACL is not the same question as who is on it. This one is protected, carries
   * exactly three non-inherited full-control rules, and grants Everyone — so it satisfies every
   * check that does not compare SIDs, and hardening would report success and leave it alone.
   */
  it('repairs a protected three-rule DACL that grants the wrong principal', () => {
    const file = join(root, 'substituted.json')
    writeFileSync(file, '{"token":"secret"}')
    plantDacl(file, [`*${EVERYONE_SID}:(F)`, '*S-1-5-18:(F)', '*S-1-5-32-544:(F)'])

    const before = readAclEntries(file)
    expect(before, listed(before)).toHaveLength(3)
    expect(before.every((entry) => !entry.includes('(I)'))).toBe(true)
    expect(before.some((entry) => entry.startsWith('Everyone:'))).toBe(true)

    expect(restrictWindowsPathSync(file, false)).toBe(true)

    const after = readAclEntries(file)
    expect(after, listed(after)).toHaveLength(3)
    expect(after.some((entry) => entry.startsWith('Everyone:'))).toBe(false)
  })

  /**
   * Wrong *flags* rather than a wrong principal. Both of these are protected, carry three
   * non-inherited full-control rules for exactly the right SIDs, and differ from correct only in
   * their inheritance flags — so a check that tests OI alone accepts them.
   *
   * That under-check was harmless while /reset + /grant ran unconditionally and repaired whatever
   * was there. Verify-first made it load-bearing: what verification accepts is now left alone.
   */
  it.each([
    ['(OI) without (CI), leaving subdirectories unprotected', '(OI)(F)'],
    ['(OI)(CI)(IO), which grants nobody anything on the directory itself', '(OI)(CI)(IO)(F)']
  ])('repairs a directory whose rules are %s', (_label, rights) => {
    const dir = join(root, `wrong-flags-${rights.replace(/[^A-Z]/g, '')}`)
    mkdirSync(dir)
    plantDacl(dir, [
      `*${currentUserSid()}:${rights}`,
      `*S-1-5-18:${rights}`,
      `*S-1-5-32-544:${rights}`
    ])

    const before = readAclEntries(dir)
    expect(before, listed(before)).toHaveLength(3)
    expect(before.every((entry) => !entry.includes('(I)'))).toBe(true)
    expect(before.every((entry) => entry.endsWith(rights))).toBe(true)

    expect(restrictWindowsPathSync(dir, true)).toBe(true)

    const after = readAclEntries(dir)
    expect(after, listed(after)).toHaveLength(3)
    expect(after.every((entry) => entry.endsWith(':(OI)(CI)(F)'))).toBe(true)

    // The point of the (IO) case: before the repair the directory object grants nobody anything,
    // so Orca cannot write into the directory it just cached as hardened.
    const child = join(dir, 'child.json')
    expect(() => writeFileSync(child, '{}')).not.toThrow()
    expect(readAclEntries(child).every((entry) => entry.includes('(I)'))).toBe(true)
  })

  it('is idempotent: a second harden leaves the same DACL', () => {
    const file = join(root, 'idempotent.json')
    writeFileSync(file, '{}')

    expect(restrictWindowsPathSync(file, false)).toBe(true)
    const first = readAclEntries(file)
    expect(restrictWindowsPathSync(file, false)).toBe(true)

    expect(readAclEntries(file)).toEqual(first)
  })

  /**
   * Verification writes a temp SDDL file. If it cannot, the ACL may well have been applied — but
   * it cannot be *proved*, so hardening must report failure rather than assume success. Fail
   * closed, and say so: a silently-unverifiable control is the shape of the original bug.
   */
  it('reports failure, loudly, when verification cannot write its descriptor', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const file = join(root, 'unverifiable.json')
    writeFileSync(file, '{}')
    const realTemp = process.env.TEMP
    const realTmp = process.env.TMP
    // Point the descriptor save at a directory that cannot exist.
    process.env.TEMP = join(root, 'no-such-dir', 'nested')
    process.env.TMP = process.env.TEMP

    try {
      expect(restrictWindowsPathSync(file, false)).toBe(false)
      expect(warn).toHaveBeenCalledWith(
        '[secure-path.windows-acl] failed to restrict path',
        expect.objectContaining({ stage: 'verify' })
      )
    } finally {
      if (realTemp === undefined) {
        delete process.env.TEMP
      } else {
        process.env.TEMP = realTemp
      }
      if (realTmp === undefined) {
        delete process.env.TMP
      } else {
        process.env.TMP = realTmp
      }
      warn.mockRestore()
    }

    // And the ACL itself was still applied, so the failure is a loss of proof, not of protection.
    expect(readAclEntries(file)).toHaveLength(3)
  })

  it('reports failure for a path that does not exist', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(restrictWindowsPathSync(join(root, 'absent.json'), false)).toBe(false)
    expect(warn).toHaveBeenCalledWith(
      '[secure-path.windows-acl] failed to restrict path',
      expect.objectContaining({ stage: 'reset' })
    )
    warn.mockRestore()
  })

  /**
   * Skipped rather than branched: elevated, hardening *succeeds* here, so the case would assert
   * nothing and would instead rewrite `hosts`. `icacls /reset` is no undo — it drops all explicit
   * ACEs, and `hosts` ships with an explicit `NT AUTHORITY\SYSTEM:(F)`. Ephemeral on a CI runner;
   * permanent for anyone running this lane from an elevated shell. So: assert, or skip.
   */
  it.skipIf(elevated)('reports failure for a path it has no permission to modify', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Owned by TrustedInstaller; a non-elevated user cannot rewrite its DACL.
    const systemFile = windowsSystem32Binary('drivers\\etc\\hosts')

    expect(restrictWindowsPathSync(systemFile, false)).toBe(false)
    expect(warn).toHaveBeenCalledWith(
      '[secure-path.windows-acl] failed to restrict path',
      expect.objectContaining({ detail: expect.stringContaining('denied') })
    )
    warn.mockRestore()
  })

  /**
   * `void promise.then(onSettled)` attaches no rejection handler, so a throw from `onSettled` —
   * which runs *after* the promise resolved, outside every try/catch inside the apply — rejects a
   * promise nobody holds. Node's default turns that into a dead Electron main process, which
   * presents as an Orca crash rather than as the hardening problem it is.
   */
  it('reports rather than crashes when the settlement callback throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reports: SecurePathHardeningReport[] = []
    setSecurePathHardeningReporter((entry) => reports.push(entry))
    const file = join(root, 'settle-throws.json')
    writeFileSync(file, '{}')

    const unhandled: unknown[] = []
    const capture = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', capture)
    let settled = false
    try {
      bestEffortRestrictWindowsPath(file, false, () => {
        settled = true
        throw new Error('settlement callback exploded')
      })
      await vi.waitFor(() => expect(settled).toBe(true))
      // An unhandled rejection is raised a turn later, so give the loop one.
      await new Promise((resolve) => setTimeout(resolve, 50))
    } finally {
      process.off('unhandledRejection', capture)
      setSecurePathHardeningReporter(null)
      warn.mockRestore()
    }

    expect(unhandled).toEqual([])
    expect(reports).toContainEqual(
      expect.objectContaining({
        stage: 'settle',
        detail: expect.stringContaining('settlement callback exploded')
      })
    )
  })
})
