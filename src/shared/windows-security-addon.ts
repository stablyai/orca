import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, isAbsolute, join, relative, toNamespacedPath } from 'node:path'
import type * as WindowsSecurityModule from '@orca/windows-security'
import { ORCAD_WINDOWS_SECURITY_FILENAME } from './orcad-artifacts'

export type { GrantAccessOptions, WindowsAce, WindowsDacl } from '@orca/windows-security'
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

/**
 * The addon, or why it cannot load on this host. orcad ships the bare binary at its slot root,
 * beside its server bundles and two levels above its CLI bundle (`out/cli/index.js`). Desktop and
 * the CLI load the workspace package, but only from inside the app: a bare specifier otherwise
 * walks every parent up to `C:\node_modules`, which any local user may create.
 */
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

/**
 * Where the app's own node_modules live: the packaged resources directory, or this checkout
 * (electron-vite puts shared code one level deeper, in `out/main/chunks`).
 */
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

/**
 * Every path is namespaced (`\\?\`) once, here: the Win32 security APIs are MAX_PATH-limited.
 *
 * Async DACL writes to one path run in order. A grant reads the DACL and writes back a merge, so
 * one racing a re-lock on another pool thread could land last and restore the broader DACL. A
 * synchronous grantDirAcl is not ordered against them, but it runs to completion on the main
 * thread, so restrictAsync's post-apply verify (a later main-thread continuation) sees its result:
 * a resurrected broad DACL fails that verify, which evicts the directory to retry under the budget.
 */
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
        inPathOrder(path, (namespaced) => raw.grantAccessAsync(namespaced, sid, mask, options))
    }
  }
}

/** Installs `addon` (a fake, or null for "cannot load") behind the same wrapping as the real one. */
export function setWindowsSecurityForTests(addon: WindowsSecurityAddon | null): void {
  loaded = addon ? prepare(addon) : { error: 'disabled for tests' }
}

/** Forgets the loaded addon and its SID. */
export function resetWindowsSecurityLoadForTests(): void {
  loaded = null
}
