import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runProcessSync } from '@orca/process-host'
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

/** Verify Orca’s native addon against real NTFS DACLs; upstream tests cannot establish our secure-file assumptions. */
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

  it('verifies strict creation and reads bounded bytes and DACL through the same handle', () => {
    const path = join(root, 'strict-token')
    addon.createFileWithDacl(
      path,
      `D:P(A;;FA;;;SY)(A;;FA;;;${sid})`,
      Buffer.from('fixture-only'),
      true
    )
    const read = addon.readFileWithDacl(path, 100)
    expect(new TextDecoder().decode(read?.data)).toBe('fixture-only')
    expect(read?.dacl?.protected).toBe(true)
    expect(() => addon.readFileWithDacl(path, 2)).toThrow('ReadFileWithDacl')
    expect(addon.readFileWithDacl(join(root, 'absent-token'), 100)).toBeNull()
    expect(() => addon.readFileWithDacl(root, 100)).toThrow()
  })

  it('preserves disposable-item metadata, counted UTF-8/subarrays, and the native cap', () => {
    const target = `orca-sta11846-test:${randomUUID()}`
    expect(target).not.toBe('gemini:antigravity')
    expect(addon.readGenericCredential(target), 'initial disposable-target absence').toBeNull()
    const fixture = readFileSync(
      new URL('./windows-generic-credential.test-fixture.py', import.meta.url),
      'utf8'
    )
    const diagnostics: string[] = []
    const failures: Error[] = []
    const processDetails = (phase: string, result: ReturnType<typeof runProcessSync>) => {
      const details = JSON.stringify({
        phase,
        code: result.code,
        signal: result.signal,
        timedOut: result.timedOut,
        stdout: result.stdout.slice(0, 2048),
        stderr: result.stderr.slice(0, 2048)
      })
      diagnostics.push(details)
      return details
    }
    const metadata = (phase: string) => {
      const result = runProcessSync({
        program: 'python',
        args: ['-c', fixture, phase, target],
        timeoutMs: 5000
      })
      expect(result.code, processDetails(phase, result)).toBe(0)
    }
    let phase = 'seed'
    try {
      metadata('seed')
      const bytes = Buffer.from('{"access_token":"fixture-only-テスト"}')
      const backing = Buffer.concat([Buffer.from('prefix'), bytes, Buffer.from('suffix')])
      phase = 'native counted UTF-8/subarray'
      addon.writeGenericCredential(target, 'antigravity', backing.subarray(6, 6 + bytes.length))
      expect(addon.readGenericCredential(target)).toEqual(bytes)
      phase = 'native replacement'
      addon.writeGenericCredential(target, 'antigravity', Buffer.from('replacement-fixture'))
      expect(new TextDecoder().decode(addon.readGenericCredential(target) ?? undefined)).toBe(
        'replacement-fixture'
      )
      phase = 'verify'
      metadata('verify')
      phase = 'native over-cap rejection and unchanged bytes'
      expect(() =>
        addon.writeGenericCredential(target, 'antigravity', Buffer.alloc(2561))
      ).toThrow()
      expect(new TextDecoder().decode(addon.readGenericCredential(target) ?? undefined)).toBe(
        'replacement-fixture'
      )
      phase = 'native exact-cap write/readback'
      addon.writeGenericCredential(target, 'antigravity', Buffer.alloc(2560, 65))
      expect(addon.readGenericCredential(target)).toEqual(Buffer.alloc(2560, 65))
    } catch (error) {
      failures.push(new Error(`Disposable credential ${phase} failed`, { cause: error }))
    } finally {
      try {
        const result = runProcessSync({
          program: 'cmdkey.exe',
          args: [`/delete:${target}`],
          timeoutMs: 5000
        })
        expect(result.code, processDetails('delete', result)).toBe(0)
      } catch (error) {
        failures.push(new Error('Disposable credential deletion failed', { cause: error }))
      }
      try {
        expect(addon.readGenericCredential(target)).toBeNull()
        diagnostics.push('cleanup disposable-target absence confirmed')
      } catch (error) {
        failures.push(new Error('Disposable credential cleanup absence failed', { cause: error }))
      }
    }
    if (failures.length) {
      const errors = failures.map(
        (cause) =>
          new Error(`Disposable credential diagnostics:\n${diagnostics.join('\n')}`, { cause })
      )
      throw errors.length === 1
        ? errors[0]
        : new AggregateError(errors, 'Disposable credential body/cleanup failures')
    }
  })

  it('marks a native read failure with its syscall origin', () => {
    const invalidTarget = `orca-sta11846-invalid:${'x'.repeat(32768)}`
    expect(() => addon.readGenericCredential(invalidTarget)).toThrow(
      expect.objectContaining({ syscall: 'CredReadW', win32Code: expect.any(Number) })
    )
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

  // Unsupported ACEs return no SID so policy can refuse rules it cannot evaluate.
  it('reads a conditional ACE back as an unsupported type with no SID', () => {
    const path = join(root, 'conditional.txt')
    writeFileSync(path, '')
    addon.setDaclSddl(path, `D:P(A;;FA;;;${sid})(XA;;FA;;;WD;(Member_of {SID(WD)}))`)

    const aces = addon.getDaclAces(path)?.aces ?? []
    expect(aces[0]).toMatchObject({ type: ACCESS_ALLOWED_ACE_TYPE, sid })
    expect(aces[1]).toMatchObject({ sid: null })
    expect([ACCESS_ALLOWED_ACE_TYPE, ACCESS_DENIED_ACE_TYPE]).not.toContain(aces[1]?.type)
  })

  // Hardening must not turn a parent’s broader inherited grant into an explicit rule.
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
