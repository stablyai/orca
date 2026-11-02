import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ACCESS_ALLOWED_ACE_TYPE,
  ACCESS_DENIED_ACE_TYPE,
  CONTAINER_INHERIT_ACE,
  OBJECT_INHERIT_ACE
} from './windows-secure-dacl'
import {
  loadWindowsSecurity,
  WINDOWS_FILE_ALL_ACCESS,
  type WindowsSecurity
} from './windows-security-addon'

const INHERITED_ACE = 0x10
import { removeTreeSync } from './windows-transient-lock-removal'

/**
 * The addon is Orca's own C++, so nothing upstream proves it moves DACLs the way the secure-file
 * policy assumes. These read every result back off a real NTFS volume.
 */
const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

describeOnWindows('native windows-security addon against a real filesystem', () => {
  let addon: WindowsSecurity['addon']
  let sid: string
  let root: string

  beforeAll(() => {
    const loaded = loadWindowsSecurity()
    if ('error' in loaded) {
      throw new Error(`the windows-security addon did not load: ${loaded.error}`)
    }
    addon = loaded.addon
    sid = loaded.userSid
    root = mkdtempSync(join(tmpdir(), 'orca-windows-security-'))
  })

  afterAll(() => {
    removeTreeSync(root)
  })

  it('reports the token user as a domain-relative SID this process can use', () => {
    // S-1-5-21: a local or AD account; S-1-12-1: an Entra ID account.
    expect(sid).toMatch(/^S-1-(?:5-21|12-1)(?:-\d+){4}$/)
    const path = join(root, 'only-me.txt')
    addon.createFileWithDacl(path, `D:P(A;;FA;;;${sid})`, Buffer.from('mine'))
    // A DACL naming only that SID still lets this process read: it is our identity.
    expect(readFileSync(path, 'utf-8')).toBe('mine')
  })

  it('creates a file that is restricted from its first instant, contents intact', () => {
    const path = join(root, 'born.json')
    addon.createFileWithDacl(path, `D:P(A;;FA;;;SY)(A;;FA;;;${sid})`, Buffer.from('{"k":1}'))

    expect(readFileSync(path, 'utf-8')).toBe('{"k":1}')
    const dacl = addon.getDaclAces(path)
    expect(dacl?.protected).toBe(true)
    expect(dacl?.aces.map((ace) => [ace.type, ace.sid, ace.flags, ace.mask])).toEqual([
      [ACCESS_ALLOWED_ACE_TYPE, 'S-1-5-18', 0, WINDOWS_FILE_ALL_ACCESS],
      [ACCESS_ALLOWED_ACE_TYPE, sid, 0, WINDOWS_FILE_ALL_ACCESS]
    ])
  })

  it('refuses to adopt an existing file, whose own DACL would survive', () => {
    const path = join(root, 'existing.json')
    writeFileSync(path, 'old')
    expect(() => addon.createFileWithDacl(path, `D:P(A;;FA;;;${sid})`, Buffer.from('new'))).toThrow(
      'CreateFileW failed with Win32 error 80'
    )
    expect(readFileSync(path, 'utf-8')).toBe('old')
  })

  it('surfaces Win32 failures with their code instead of crashing', () => {
    expect(() => addon.getDaclAces(join(root, 'missing'))).toThrow(
      'GetNamedSecurityInfoW failed with Win32 error 2'
    )
    expect(() => addon.setDaclSddl(join(root, 'missing'), `D:P(A;;FA;;;${sid})`)).toThrow(
      'Win32 error 2'
    )
    // A missing DACL means "everyone, full control"; the addon must never install one.
    const path = join(root, 'null-dacl.txt')
    writeFileSync(path, '')
    expect(() => addon.setDaclSddl(path, 'O:BA')).toThrow('Win32 error 1338')
  })

  // Structure, not policy: anything but a plain allow or deny comes back without a SID, so the
  // caller can refuse what it cannot evaluate.
  it('reads a conditional ACE back as an unsupported type with no SID', () => {
    const path = join(root, 'conditional.txt')
    writeFileSync(path, '')
    addon.setDaclSddl(path, `D:P(A;;FA;;;${sid})(XA;;FA;;;WD;(Member_of {SID(WD)}))`)

    const aces = addon.getDaclAces(path)?.aces ?? []
    expect(aces[0]).toMatchObject({ type: ACCESS_ALLOWED_ACE_TYPE, sid })
    expect(aces[1]).toMatchObject({ sid: null })
    expect([ACCESS_ALLOWED_ACE_TYPE, ACCESS_DENIED_ACE_TYPE]).not.toContain(aces[1]?.type)
  })

  // Why it matters: hardening passes only explicit rules, and must never smuggle in a
  // parent's broader grant by echoing an inherited ACE back.
  it('drops inherited ACEs supplied to setDaclSddl and recomputes them from the parent', () => {
    const child = join(root, 'inheriting')
    mkdirSync(child)
    addon.setDaclSddl(child, `D:(A;OICI;FA;;;${sid})(A;OICIID;FA;;;WD)`)

    const dacl = addon.getDaclAces(child)
    expect(dacl?.aces.some((ace) => ace.sid === 'S-1-1-0')).toBe(false)
    expect(dacl?.aces.some((ace) => ace.sid === sid && (ace.flags & INHERITED_ACE) === 0)).toBe(
      true
    )
  })

  it('keeps canonical order when a grant lands beside an explicit deny', () => {
    const path = join(root, 'canonical.txt')
    writeFileSync(path, '')
    addon.setDaclSddl(path, 'D:AI(D;;FA;;;BG)(A;;FA;;;SY)')

    addon.grantAccess(path, sid, WINDOWS_FILE_ALL_ACCESS, { inheritable: false, replace: true })

    const aces = addon.getDaclAces(path)?.aces ?? []
    const kinds = aces.map((ace) =>
      (ace.flags & INHERITED_ACE) !== 0
        ? 'inherited'
        : ace.type === ACCESS_DENIED_ACE_TYPE
          ? 'deny'
          : 'allow'
    )
    // Explicit deny, then explicit allows, then inherited: the order access checks rely on.
    expect(kinds.indexOf('deny')).toBe(0)
    expect(kinds.lastIndexOf('allow')).toBeLessThan(kinds.indexOf('inherited'))
    expect(aces).toContainEqual(
      expect.objectContaining({ type: ACCESS_ALLOWED_ACE_TYPE, sid, flags: 0 })
    )
  })

  it('merges a grant without disturbing other principals or the protection state', () => {
    const path = join(root, 'merged.txt')
    writeFileSync(path, '')
    addon.setDaclSddl(path, `D:P(A;;FA;;;SY)(A;;FA;;;${sid})`)

    addon.grantAccess(path, 'S-1-15-2-2', 0x1200a9, { inheritable: false, replace: false })

    const dacl = addon.getDaclAces(path)
    expect(dacl?.protected).toBe(true)
    expect(dacl?.aces.map((ace) => ace.sid).sort()).toEqual([sid, 'S-1-15-2-2', 'S-1-5-18'].sort())
  })

  // A NULL DACL already allows everyone; merging a grant into it would revoke every other principal.
  it('leaves a NULL DACL as it is when granting', () => {
    const path = join(root, 'null-dacl-grant.txt')
    addon.createFileWithDacl(path, 'D:NO_ACCESS_CONTROL', Buffer.from(''))
    expect(addon.getDaclAces(path)).toBeNull()

    addon.grantAccess(path, sid, WINDOWS_FILE_ALL_ACCESS, { inheritable: false, replace: true })

    expect(addon.getDaclAces(path)).toBeNull()
  })

  it('reaches a path longer than MAX_PATH', () => {
    let dir = join(root, 'long')
    while (dir.length < 280) {
      dir = join(dir, 'x'.repeat(40))
    }
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'secret.json')
    addon.createFileWithDacl(path, `D:P(A;;FA;;;${sid})`, Buffer.from('{}'))

    addon.grantAccess(path, 'S-1-5-18', WINDOWS_FILE_ALL_ACCESS, {
      inheritable: false,
      replace: false
    })

    expect(
      addon
        .getDaclAces(path)
        ?.aces.map((ace) => ace.sid)
        .sort()
    ).toEqual(['S-1-5-18', sid].sort())
  })

  it('runs DACL writes on the thread pool and rejects with the Win32 code', async () => {
    const dir = join(root, 'async')
    mkdirSync(dir)
    await addon.setDaclSddlAsync(dir, `D:P(A;OICI;FA;;;${sid})`)
    expect(addon.getDaclAces(dir)?.protected).toBe(true)

    await addon.grantAccessAsync(dir, 'S-1-5-18', WINDOWS_FILE_ALL_ACCESS, {
      inheritable: true,
      replace: true
    })
    expect(addon.getDaclAces(dir)?.aces).toContainEqual(
      expect.objectContaining({
        sid: 'S-1-5-18',
        flags: OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
        mask: WINDOWS_FILE_ALL_ACCESS
      })
    )

    await expect(
      addon.setDaclSddlAsync(join(root, 'missing-dir'), `D:P(A;;FA;;;${sid})`)
    ).rejects.toThrow('Win32 error 2')
  })
})
