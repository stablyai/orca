import { writeFileSync } from 'node:fs'
import { reportSecurePathHardening as report } from './secure-path-hardening-report'
import { loadWindowsSecurity, type WindowsSecurity } from './windows-security-addon'
import {
  findPrivateDaclViolation,
  findSecureDaclViolation,
  hardenedDaclSddl
} from './windows-secure-dacl'

/** Restrict directories off-thread because propagation walks all descendants; report failures and resolve false for retry. */
export function restrictWindowsDirectory(dirPath: string): Promise<boolean> {
  const security = securityFor(dirPath)
  return security ? restrictAsync(security, dirPath, true) : Promise.resolve(false)
}

async function restrictAsync(
  security: WindowsSecurity,
  targetPath: string,
  isDirectory: boolean
): Promise<boolean> {
  // Verify before rewriting: directory propagation can cost seconds on large userData trees.
  if (violationOf(security, targetPath, isDirectory) === null) {
    return true
  }
  try {
    await security.addon.setDaclSddlAsync(
      targetPath,
      hardenedDaclSddl(security.userSid, isDirectory)
    )
  } catch (error) {
    report(targetPath, 'apply', String(error))
    return false
  }
  return verifyAfterApply(security, targetPath, isDirectory)
}

/** Restricts one file on the thread pool; never rejects, resolves whether the DACL holds. */
export function restrictWindowsFile(filePath: string): Promise<boolean> {
  const security = securityFor(filePath)
  return security ? restrictAsync(security, filePath, false) : Promise.resolve(false)
}

/** Verifies and, only when that fails, rewrites the DACL on the calling thread. */
export function restrictWindowsPathSync(targetPath: string, isDirectory: boolean): boolean {
  const security = securityFor(targetPath)
  if (!security) {
    return false
  }
  if (violationOf(security, targetPath, isDirectory) === null) {
    return true
  }
  try {
    security.addon.setDaclSddl(targetPath, hardenedDaclSddl(security.userSid, isDirectory))
  } catch (error) {
    // Why not fatal: a failed apply must not crash the caller; false leaves the path retryable.
    report(targetPath, 'apply', String(error))
    return false
  }
  return verifyAfterApply(security, targetPath, isDirectory)
}

/** Create restricted so secrets never inherit a broader directory DACL. Missing addon writes plainly/returns false;
 * loaded addon create failures throw. Read back to confirm filesystem enforcement. */
export function writeRestrictedWindowsFile(
  targetPath: string,
  contents: string | Buffer,
  strict = false
): boolean {
  const security = securityFor(targetPath)
  if (!security) {
    if (strict) {
      throw new Error('Private Windows credential-file protection is unavailable.')
    }
    writeFileSync(targetPath, contents, { encoding: 'utf-8', mode: 0o600 })
    return false
  }
  security.addon.createFileWithDacl(
    targetPath,
    hardenedDaclSddl(security.userSid, false),
    typeof contents === 'string' ? Buffer.from(contents, 'utf-8') : contents,
    strict
  )
  // Why read it back: FAT32 and some shares accept the descriptor and silently drop it.
  return verifyAfterApply(security, targetPath, false)
}

export function readPrivateWindowsFile(path: string, maxBytes: number): Buffer | null {
  const security = loadWindowsSecurity()
  if ('error' in security) {
    throw new Error('Private Windows credential-file protection is unavailable.')
  }
  const file = security.addon.readFileWithDacl(path, maxBytes)
  if (!file) {
    return null
  }
  if (findPrivateDaclViolation(file.dacl, security.userSid)) {
    throw new Error('The Windows credential file permits access by another user.')
  }
  return Buffer.from(file.data.buffer, file.data.byteOffset, file.data.byteLength)
}

function verifyAfterApply(
  security: WindowsSecurity,
  targetPath: string,
  isDirectory: boolean
): boolean {
  const invalid = violationOf(security, targetPath, isDirectory)
  if (invalid) {
    report(targetPath, 'verify', invalid)
    return false
  }
  return true
}

/** Why the DACL on disk is not acceptable, or null when it is. */
function violationOf(
  security: WindowsSecurity,
  targetPath: string,
  isDirectory: boolean
): string | null {
  try {
    return findSecureDaclViolation(
      security.addon.getDaclAces(targetPath),
      security.userSid,
      isDirectory
    )
  } catch (error) {
    return String(error)
  }
}

let reportedLoadFailure = false

function securityFor(targetPath: string): WindowsSecurity | null {
  const loaded = loadWindowsSecurity()
  if ('error' in loaded) {
    // Once per process: a missing addon is a packaging fault, and every secure write would repeat it.
    if (!reportedLoadFailure) {
      reportedLoadFailure = true
      report(targetPath, 'addon', loaded.error)
    }
    return null
  }
  return loaded
}
