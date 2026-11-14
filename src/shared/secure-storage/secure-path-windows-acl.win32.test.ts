import { lstatSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { __resetSecureFileHardenedPathsForTests } from './secure-file'
import {
  setSecurePathHardeningReporter,
  type SecurePathHardeningReport
} from './secure-path-hardening-report'
import { restrictWindowsPathSync } from './secure-path-windows-acl'
import {
  loadWindowsSecurity,
  resetWindowsSecurityLoadForTests,
  type WindowsSecurity
} from '../windows-security-addon'
import { CONTAINER_INHERIT_ACE, OBJECT_INHERIT_ACE } from '../windows-secure-dacl'
import { removeTreeSync } from '../windows-transient-lock-removal'

/** Real NTFS read-back covers what fake addons cannot: relocated C:\ roots inheriting broad Modify access. Windows only. */
const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

describeOnWindows('Windows secure paths against a real filesystem', () => {
  let addon: WindowsSecurity['addon']
  let sid: string
  let root: string
  /** A relocated data root: `C:\orca-…` inherits BUILTIN\Users and Authenticated Users from C:\. */
  let relocatedRoot: string

  const daclOf = (path: string) => addon.getDaclAces(path)
  const sidsOf = (path: string) => (daclOf(path)?.aces ?? []).map((ace) => ace.sid).sort()
  const INHERITABLE = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
  const INHERITED_ACE = 0x10
  const ORCA_PRINCIPALS = () => ['S-1-5-18', 'S-1-5-32-544', sid].sort()

  beforeAll(() => {
    const loaded = loadWindowsSecurity()
    if ('error' in loaded) {
      throw new Error(`the windows-security addon did not load: ${loaded.error}`)
    }
    addon = loaded.addon
    sid = loaded.userSid
    root = mkdtempSync(join(tmpdir(), 'orca-acl-win32-'))
    relocatedRoot = join('C:\\', `orca-acl-test-${randomBytes(4).toString('hex')}`)
    mkdirSync(relocatedRoot)
  })

  afterEach(() => {
    resetWindowsSecurityLoadForTests()
    __resetSecureFileHardenedPathsForTests()
    setSecurePathHardeningReporter(null)
  })

  afterAll(() => {
    // Hostile DACL fixtures may become undeletable if repair regresses; restore this user’s access before cleanup.
    for (const tree of [root, relocatedRoot]) {
      unlockTree(tree)
      removeTreeSync(tree)
    }
  })

  function unlockTree(path: string): void {
    try {
      addon.setDaclSddl(path, `D:P(A;OICI;FA;;;${sid})`)
    } catch {
      return
    }
    if (lstatSync(path).isDirectory()) {
      for (const name of readdirSync(path)) {
        unlockTree(join(path, name))
      }
    }
  }

  it('restricts a real file, dropping inherited and planted foreign rules', () => {
    const file = join(relocatedRoot, 'credential.json')
    writeFileSync(file, '{"token":"secret"}')
    addon.grantAccess(file, 'S-1-1-0', 0x120089, { inheritable: false, replace: false })
    expect(sidsOf(file)).toContain('S-1-1-0')

    expect(restrictWindowsPathSync(file, false)).toBe(true)

    expect(daclOf(file)?.protected).toBe(true)
    expect(sidsOf(file)).toEqual(ORCA_PRINCIPALS())
  })

  it('gives a directory inheritable rules so files created inside start restricted', () => {
    const dir = join(relocatedRoot, 'secure-dir')
    mkdirSync(dir)

    expect(restrictWindowsPathSync(dir, true)).toBe(true)

    expect(daclOf(dir)?.aces.every((ace) => ace.flags === INHERITABLE)).toBe(true)
    const child = join(dir, 'plain.json')
    writeFileSync(child, '{}')
    expect(sidsOf(child)).toEqual(ORCA_PRINCIPALS())
    expect(daclOf(child)?.aces.every((ace) => (ace.flags & INHERITED_ACE) !== 0)).toBe(true)
  })

  it.each([
    ['(OI) without (CI), leaving subdirectories unprotected', 'OI'],
    ['(OI)(CI)(IO), which grants nobody anything on the directory itself', 'OICIIO']
  ])('repairs a directory whose rules are %s', (_label, flags) => {
    const dir = join(root, `wrong-flags-${flags}`)
    mkdirSync(dir)
    addon.setDaclSddl(dir, `D:P(A;${flags};FA;;;SY)(A;${flags};FA;;;BA)(A;${flags};FA;;;${sid})`)

    expect(restrictWindowsPathSync(dir, true)).toBe(true)

    expect(daclOf(dir)?.aces.every((ace) => ace.flags === INHERITABLE)).toBe(true)
    expect(() => writeFileSync(join(dir, 'child.json'), '{}')).not.toThrow()
  })

  it('repairs a protected three-rule DACL that grants the wrong principal', () => {
    const file = join(root, 'substituted.json')
    writeFileSync(file, '{}')
    addon.setDaclSddl(file, 'D:P(A;;FA;;;WD)(A;;FA;;;SY)(A;;FA;;;BA)')

    expect(restrictWindowsPathSync(file, false)).toBe(true)

    expect(sidsOf(file)).toEqual(ORCA_PRINCIPALS())
  })

  it('hardens a path longer than MAX_PATH', () => {
    let dir = join(root, 'long')
    while (dir.length < 280) {
      dir = join(dir, 'x'.repeat(40))
    }
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'secret.json')
    writeFileSync(file, '{}')

    expect(restrictWindowsPathSync(file, false)).toBe(true)
    expect(sidsOf(`\\\\?\\${file}`)).toEqual(ORCA_PRINCIPALS())
  })

  it('reports failure, not success, for a path that does not exist', () => {
    const reports: SecurePathHardeningReport[] = []
    setSecurePathHardeningReporter((entry) => reports.push(entry))

    expect(restrictWindowsPathSync(join(root, 'missing.json'), false)).toBe(false)
    expect(reports).toContainEqual(expect.objectContaining({ stage: 'apply' }))
  })
})
