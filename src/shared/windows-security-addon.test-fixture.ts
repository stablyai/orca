import { writeFileSync } from 'node:fs'
import type {
  GrantAccessOptions,
  WindowsAce,
  WindowsDacl,
  WindowsSecurityAddon
} from './windows-security-addon'

export const FAKE_USER_SID = 'S-1-5-21-1-2-3-1001'

/** What an untouched path reads back as: inherited from a relocated root like `C:\orca-data`. */
export const INHERITED_SDDL = `D:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;${FAKE_USER_SID})(A;ID;0x1301bf;;;AU)`

const SID_ALIASES: Record<string, string> = {
  AC: 'S-1-15-2-1',
  AU: 'S-1-5-11',
  BA: 'S-1-5-32-544',
  BU: 'S-1-5-32-545',
  SY: 'S-1-5-18',
  WD: 'S-1-1-0'
}
const ACE_TYPES: Record<string, number> = { A: 0, D: 1, OA: 5, XA: 9 }
const ACE_FLAGS: Record<string, number> = { OI: 0x1, CI: 0x2, NP: 0x4, IO: 0x8, ID: 0x10 }
const RIGHTS: Record<string, number> = { FA: 0x1f01ff, FR: 0x120089, GA: 0x10000000 }

/** Test-only SDDL parser for native getDaclAces-shaped fixtures; production never parses SDDL. */
export function daclFromSddl(sddl: string): WindowsDacl | null {
  if (sddl.includes('NO_ACCESS_CONTROL')) {
    return null
  }
  const match = /^D:([A-Z]*)(.*)$/.exec(sddl)
  if (!match) {
    throw new Error(`fixture SDDL is not a DACL: ${sddl}`)
  }
  const aces: WindowsAce[] = []
  // A conditional ACE's trailing expression holds parentheses; only its type matters here.
  for (const [, body] of match[2]!.matchAll(/\(((?:[^()]|\([^()]*\))*)\)/g)) {
    const [type = '', flags = '', rights = '', , , sid = ''] = body!.split(';')
    const plain = type === 'A' || type === 'D'
    aces.push({
      type: ACE_TYPES[type] ?? 0xff,
      flags: (flags.match(/../g) ?? []).reduce((all, token) => all | (ACE_FLAGS[token] ?? 0), 0),
      mask: RIGHTS[rights] ?? (Number.parseInt(rights, 16) || 0),
      sid: plain ? (SID_ALIASES[sid] ?? sid) : null
    })
  }
  return { protected: match[1]!.includes('P'), aces }
}

export type FakeWindowsSecurityCall =
  | { op: 'get' | 'set' | 'setAsync'; path: string; addonPath: string; sddl?: string }
  | { op: 'create'; path: string; addonPath: string; sddl: string }
  | {
      op: 'grant' | 'grantAsync'
      path: string
      addonPath: string
      sid: string
      mask: number
      options: GrantAccessOptions
    }

export type FakeWindowsSecurity = WindowsSecurityAddon & {
  calls: FakeWindowsSecurityCall[]
  /** The SDDL each path reads back as; absent paths read as INHERITED_SDDL. */
  dacls: Map<string, string>
  /** Paths whose writes (set, create, grant) throw. */
  failing: Set<string>
  /** When set, setDaclSddlAsync parks here instead of settling. */
  holdAsync: boolean
  /** Settles every parked setDaclSddlAsync. */
  releaseAsync: () => void
  callsFor: (op: FakeWindowsSecurityCall['op'], path?: string) => FakeWindowsSecurityCall[]
}

function win32Error(syscall: string): Error {
  return new Error(`${syscall} failed with Win32 error 5`)
}

/** The path the test used: the addon wrapper namespaces (`\\?\`) every path on Windows. */
function plainPath(addonPath: string): string {
  if (addonPath.startsWith('\\\\?\\UNC\\')) {
    return `\\\\${addonPath.slice(8)}`
  }
  return addonPath.startsWith('\\\\?\\') ? addonPath.slice(4) : addonPath
}

/** An in-memory stand-in for native/windows-security; files it creates are real. */
export function createFakeWindowsSecurity(): FakeWindowsSecurity {
  const parked: (() => void)[] = []
  const record = <T extends FakeWindowsSecurityCall['op']>(
    op: T,
    addonPath: string,
    rest: Record<string, unknown> = {}
  ): string => {
    const path = plainPath(addonPath)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each caller passes exactly the fields its op's union member declares.
    fake.calls.push({ op, path, addonPath, ...rest } as FakeWindowsSecurityCall)
    return path
  }
  const fake: FakeWindowsSecurity = {
    calls: [],
    dacls: new Map(),
    failing: new Set(),
    holdAsync: false,
    releaseAsync: () => parked.splice(0).forEach((settle) => settle()),
    callsFor: (op, path) =>
      fake.calls.filter((call) => call.op === op && (path === undefined || call.path === path)),
    currentUserSid: () => FAKE_USER_SID,
    getDaclAces: (addonPath) => {
      const path = record('get', addonPath)
      return daclFromSddl(fake.dacls.get(path) ?? INHERITED_SDDL)
    },
    setDaclSddl: (addonPath, sddl) => {
      const path = record('set', addonPath, { sddl })
      if (fake.failing.has(path)) {
        throw win32Error('SetNamedSecurityInfoW')
      }
      fake.dacls.set(path, sddl)
    },
    setDaclSddlAsync: (addonPath, sddl) => {
      const path = record('setAsync', addonPath, { sddl })
      const settle = (resolve: () => void, reject: (error: Error) => void): void => {
        if (fake.failing.has(path)) {
          reject(win32Error('SetNamedSecurityInfoW'))
          return
        }
        fake.dacls.set(path, sddl)
        resolve()
      }
      return new Promise((resolve, reject) => {
        if (fake.holdAsync) {
          parked.push(() => settle(resolve, reject))
          return
        }
        settle(resolve, reject)
      })
    },
    createFileWithDacl: (addonPath, sddl, data) => {
      const path = record('create', addonPath, { sddl })
      if (fake.failing.has(path)) {
        throw win32Error('CreateFileW')
      }
      writeFileSync(addonPath, data, { flag: 'wx' })
      fake.dacls.set(path, sddl)
    },
    grantAccess: (addonPath, sid, mask, options) => {
      const path = record('grant', addonPath, { sid, mask, options })
      if (fake.failing.has(path)) {
        throw win32Error('SetNamedSecurityInfoW')
      }
    },
    grantAccessAsync: (addonPath, sid, mask, options) => {
      const path = record('grantAsync', addonPath, { sid, mask, options })
      return fake.failing.has(path)
        ? Promise.reject(win32Error('SetNamedSecurityInfoW'))
        : Promise.resolve()
    }
  }
  return fake
}
