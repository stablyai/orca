import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { __resetSecureFileHardenedPathsForTests, writeSecureFile } from './secure-file'
import {
  setSecurePathHardeningReporter,
  type SecurePathHardeningReport
} from './secure-path-hardening-report'
import { restrictWindowsPathSync } from './secure-path-windows-acl'
import {
  loadWindowsSecurity,
  resetWindowsSecurityLoadForTests,
  setWindowsSecurityForTests,
  type WindowsSecurity
} from './windows-security-addon'
import {
  CONTAINER_INHERIT_ACE,
  findSecureDaclViolation,
  OBJECT_INHERIT_ACE
} from './windows-secure-dacl'
import { removeTreeSync } from './windows-transient-lock-removal'

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

  it('starts from a relocated root that really is broader than Orca allows', () => {
    const verdict = findSecureDaclViolation(addon.getDaclAces(relocatedRoot), sid, true)
    expect(verdict).toMatch(/unexpected rule for S-1-5-(11|32-545)/)
  })

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

  it('never rewrites a path the icacls-era hardening already locked', () => {
    const file = join(root, 'icacls-era.json')
    writeFileSync(file, '{}')
    addon.setDaclSddl(file, `D:PAI(A;;FA;;;BA)(A;;FA;;;SY)(A;;FA;;;${sid})`)
    const before = addon.getDaclAces(file)
    const writes = countingAddon()

    expect(restrictWindowsPathSync(file, false)).toBe(true)

    expect(writes.count).toBe(0)
    expect(addon.getDaclAces(file)).toEqual(before)
  })

  it.each([
    ['spaces', 'a b c'],
    ['single quote and dollar', "quo'te $var"],
    ['backtick', 'back`tick'],
    ['semicolon and ampersand', 'semi;colon & amp'],
    ['caret and percent', 'car^et %PATH%'],
    ['non-ASCII', 'résumé 資料']
  ])('hardens a path containing %s', (_label, segment) => {
    const dir = join(root, segment)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'secret.json')
    writeFileSync(file, '{}')

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

  it('keeps hardening alive when the installed reporter throws', () => {
    setSecurePathHardeningReporter(() => {
      throw new Error('caller bug')
    })

    expect(restrictWindowsPathSync(join(root, 'missing-reporter.json'), false)).toBe(false)
  })

  it('never exposes a staged or published credential under the relocated root', async () => {
    const dir = join(relocatedRoot, 'race')
    mkdirSync(dir)
    const target = join(dir, 'orca-e2ee-keypair.json')
    const observer = observeDacls(dir, 1500)
    await observer.ready

    let restricted = 0
    const startedAt = performance.now()
    while (performance.now() - startedAt < 1000) {
      try {
        restricted += writeSecureFile(target, JSON.stringify({ secretKey: 'x'.repeat(64) })) ? 1 : 0
      } catch (error) {
        // The observer's own open handle can make a replace-rename fail; that is the racer, not us.
        expect(error).toMatchObject({ code: 'EPERM', syscall: 'rename' })
      }
    }
    const observed = await observer.result

    expect(restricted).toBeGreaterThan(50)
    expect(observed.samples).toBeGreaterThan(50)
    const broad = Object.keys(observed.distinct).filter(
      (dacl) => findSecureDaclViolation(JSON.parse(dacl), sid, false) !== null
    )
    console.log(
      `[live-acl] ${restricted} writes, ${observed.samples} DACL samples, ` +
        `${Object.keys(observed.distinct).length} distinct, ${broad.length} broad`
    )
    expect(broad).toEqual([])
    expect(daclOf(target)?.protected).toBe(true)
  })

  // Directory relock must stay off the write path and run once; allow its 60s wait plus 4,000 creates beyond the default timeout.
  it('relocks a large relocated directory off the write path, exactly once', async () => {
    const dir = join(relocatedRoot, 'large')
    mkdirSync(dir)
    for (let index = 0; index < 4000; index++) {
      writeFileSync(join(dir, `cache-${index}`), 'x')
    }
    const writes = countingAddon()

    const writeStartedAt = performance.now()
    expect(writeSecureFile(join(dir, 'secret.json'), '{}')).toBe(true)
    const writeMs = performance.now() - writeStartedAt
    writeSecureFile(join(dir, 'second.json'), '{}')

    const relockStartedAt = performance.now()
    // The parent turns protected before propagation reaches its children, so wait on both ends.
    await vi.waitFor(
      () => {
        expect(daclOf(dir)?.protected).toBe(true)
        expect(sidsOf(join(dir, 'cache-0'))).toEqual(ORCA_PRINCIPALS())
        expect(sidsOf(join(dir, 'cache-3999'))).toEqual(ORCA_PRINCIPALS())
      },
      { timeout: 60_000, interval: 20 }
    )
    const relockMs = performance.now() - relockStartedAt + writeMs
    console.log(
      `[live-acl] write ${writeMs.toFixed(1)}ms while relock of 4000 entries ~${relockMs.toFixed(0)}ms`
    )

    expect(writes.asyncCount).toBe(1)

    // A new process finds the directory already locked and leaves it alone.
    __resetSecureFileHardenedPathsForTests()
    const nextLaunch = countingAddon()
    writeSecureFile(join(dir, 'third.json'), '{}')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(nextLaunch.asyncCount + nextLaunch.count).toBe(0)
    expect(readFileSync(join(dir, 'third.json'), 'utf-8')).toBe('{}')
  }, 90_000)

  /** Installs the real addon behind a proxy that counts DACL rewrites. */
  function countingAddon(): { count: number; asyncCount: number } {
    const counts = { count: 0, asyncCount: 0 }
    setWindowsSecurityForTests({
      ...addon,
      currentUserSid: () => sid,
      setDaclSddl: (path, sddl) => {
        counts.count += 1
        addon.setDaclSddl(path, sddl)
      },
      setDaclSddlAsync: (path, sddl) => {
        counts.asyncCount += 1
        return addon.setDaclSddlAsync(path, sddl)
      }
    })
    return counts
  }
})

type ObservedDacls = { samples: number; distinct: Record<string, number> }

function observeDacls(
  dir: string,
  durationMs: number
): { ready: Promise<void>; result: Promise<ObservedDacls> } {
  const worker = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads')
    const { readdirSync } = require('node:fs')
    const { join } = require('node:path')
    const addon = require(workerData.addonPath)
    parentPort.postMessage('ready')
    const distinct = {}
    let samples = 0
    const deadline = Date.now() + workerData.durationMs
    while (Date.now() < deadline) {
      let names = []
      try { names = readdirSync(workerData.dir) } catch {}
      for (const name of names) {
        try {
          const sddl = JSON.stringify(addon.getDaclAces(join(workerData.dir, name)))
          samples += 1
          distinct[sddl] = (distinct[sddl] || 0) + 1
        } catch {}
      }
    }
    parentPort.postMessage({ samples, distinct })
    `,
    {
      eval: true,
      workerData: { dir, durationMs, addonPath: require.resolve('@orca/windows-security') }
    }
  )
  let markReady: () => void = () => undefined
  const ready = new Promise<void>((resolve) => {
    markReady = resolve
  })
  const result = new Promise<ObservedDacls>((resolve, reject) => {
    worker.on('message', (message: unknown) => {
      if (message === 'ready') {
        markReady()
        return
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the worker above posts exactly this shape after 'ready'.
      resolve(message as ObservedDacls)
      void worker.terminate()
    })
    worker.on('error', reject)
  })
  return { ready, result }
}
