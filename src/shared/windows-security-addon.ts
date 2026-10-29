import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, isAbsolute, join, relative, toNamespacedPath } from 'node:path'
import type * as WindowsSecurityModule from '@orca/windows-security'
import { ORCAD_WINDOWS_SECURITY_FILENAME } from './orcad-artifacts'

export type {
  GrantAccessOptions,
  StdHandleInheritanceFailure,
  WindowsAce,
  WindowsDacl
} from '@orca/windows-security'
export type WindowsSecurityAddon = typeof WindowsSecurityModule

/** The addon (every path namespaced, async writes ordered per path) and the token's user SID. */
export type WindowsSecurity = {
  addon: Omit<WindowsSecurityAddon, 'currentUserSid'>
  userSid: string
}

/** FILE_ALL_ACCESS, what SDDL prints as `FA`. */
export const WINDOWS_FILE_ALL_ACCESS = 0x1f01ff
/** FILE_GENERIC_READ | FILE_GENERIC_EXECUTE, what icacls calls `(RX)`. */
export const WINDOWS_FILE_READ_EXECUTE = 0x1200a9

const requireFromHere = createRequire(__filename)

let loaded: WindowsSecurity | { error: string } | null = null

/** Load orcad’s staged binary at its slot root; desktop/CLI packages must resolve inside the app.
 * Bare package lookup could escape to C:\node_modules, which another local user can create. */
export function loadWindowsSecurity(): WindowsSecurity | { error: string } {
  loaded ??= loadOnce()
  return loaded
}

function loadOnce(): WindowsSecurity | { error: string } {
  if (process.platform !== 'win32') {
    return { error: `unsupported on ${process.platform}` }
  }
  const failures: string[] = []
  const candidates = [
    () => join(__dirname, ORCAD_WINDOWS_SECURITY_FILENAME),
    () => join(__dirname, '..', '..', ORCAD_WINDOWS_SECURITY_FILENAME),
    () => trustedPackagePath(requireFromHere.resolve('@orca/windows-security'), appRoots())
  ]
  for (const candidate of candidates) {
    try {
      // Reading the SID is also what makes the package load its deferred .node binary.
      return prepare(requireFromHere(candidate()))
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    }
  }
  return { error: failures.join('; ') }
}

/** Packaged resources or checkout root; electron-vite chunks sit one level deeper in out/main/chunks. */
function appRoots(): string[] {
  const checkout =
    basename(__dirname) === 'chunks'
      ? join(__dirname, '..', '..', '..')
      : join(__dirname, '..', '..')
  // Electron only, so not on Node's Process type; the CLI runs under Electron as Node too.
  return 'resourcesPath' in process && typeof process.resourcesPath === 'string'
    ? [process.resourcesPath, checkout]
    : [checkout]
}

/** `resolved` when its real location is inside one of `roots`; throws otherwise. */
export function trustedPackagePath(resolved: string, roots: readonly string[]): string {
  const real = realpathSync(resolved)
  const inside = roots.some((root) => {
    const fromRoot = relative(realpathSync(root), real)
    return fromRoot !== '' && !fromRoot.startsWith('..') && !isAbsolute(fromRoot)
  })
  if (!inside) {
    throw new Error(`refusing @orca/windows-security outside the app: ${real}`)
  }
  return real
}

/** Namespace paths once for MAX_PATH-limited Win32 APIs. Serialize async writes per path so a read/merge grant cannot race a re-lock and restore broader access.
 * Sync grants finish on main before restrictAsync’s post-apply verification; a broader result fails verification and evicts the directory for bounded retry. */
function prepare(raw: WindowsSecurityAddon): WindowsSecurity {
  const writes = new Map<string, Promise<unknown>>()
  const inPathOrder = (path: string, write: (namespaced: string) => Promise<void>) => {
    const namespaced = toNamespacedPath(path)
    const key = namespaced.toLowerCase()
    const run = () => write(namespaced)
    const next = (writes.get(key) ?? Promise.resolve()).then(run, run)
    const settled = next.catch(() => undefined)
    writes.set(key, settled)
    void settled.then(() => {
      if (writes.get(key) === settled) {
        writes.delete(key)
      }
    })
    return next
  }
  return {
    userSid: raw.currentUserSid(),
    addon: {
      getDaclAces: (path) => raw.getDaclAces(toNamespacedPath(path)),
      setDaclSddl: (path, sddl) => raw.setDaclSddl(toNamespacedPath(path), sddl),
      setDaclSddlAsync: (path, sddl) =>
        inPathOrder(path, (namespaced) => raw.setDaclSddlAsync(namespaced, sddl)),
      createFileWithDacl: (path, sddl, data) =>
        raw.createFileWithDacl(toNamespacedPath(path), sddl, data),
      grantAccess: (path, sid, mask, options) =>
        raw.grantAccess(toNamespacedPath(path), sid, mask, options),
      grantAccessAsync: (path, sid, mask, options) =>
        inPathOrder(path, (namespaced) => raw.grantAccessAsync(namespaced, sid, mask, options)),
      clearStdHandleInheritance: () => raw.clearStdHandleInheritance()
    }
  }
}

/** Wrap fake addons identically to production; null simulates load failure. */
export function setWindowsSecurityForTests(addon: WindowsSecurityAddon | null): void {
  loaded = addon ? prepare(addon) : { error: 'disabled for tests' }
}

export function resetWindowsSecurityLoadForTests(): void {
  loaded = null
}
