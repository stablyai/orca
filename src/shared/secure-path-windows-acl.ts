import { randomBytes } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 as pathWin32 } from 'node:path'
import { runProcess, runProcessSync } from './child-process/run-process'
import { windowsSystem32Binary } from './child-process/windows-system-binary'
import {
  reportSecurePathHardening,
  type SecurePathHardeningReport
} from './secure-path-hardening-report'
import { localDomainSidOf, parseSddlDacl } from './windows-security-descriptor'

const ACL_TIMEOUT_MS = 5000

/** SYSTEM and the local Administrators group: they can take ownership regardless, so denying them buys nothing. */
const LOCAL_SYSTEM_SID = 'S-1-5-18'
const BUILTIN_ADMINISTRATORS_SID = 'S-1-5-32-544'

const WINDOWS_SID_PATTERN = /^S-1-\d+(?:-\d+)+$/

type AclPlan = {
  program: string
  /** The path as icacls must receive it, already extended-length prefixed when needed. */
  icaclsPath: string
  isDirectory: boolean
  allowedSids: string[]
  /** Resolves the machine-relative aliases `/save` emits; null when the user SID is not one. */
  localDomainSid: string | null
  resetArgs: string[]
  grantArgs: string[]
}

function buildAclPlan(targetPath: string, currentUserSid: string, isDirectory: boolean): AclPlan {
  const icaclsPath = toIcaclsPath(targetPath)
  // Directories propagate to children (artifact-intent files rely on inheritance); files take no flags.
  const rights = isDirectory ? '(OI)(CI)(F)' : '(F)'
  const allowedSids = [...new Set([currentUserSid, LOCAL_SYSTEM_SID, BUILTIN_ADMINISTRATORS_SID])]
  return {
    program: windowsSystem32Binary('icacls.exe'),
    icaclsPath,
    isDirectory,
    allowedSids,
    localDomainSid: localDomainSidOf(currentUserSid),
    // `/reset` purges explicit ACEs, which `/inheritance:r` leaves in place — a planted
    // `Everyone:(R)` survives the grant pass otherwise. The two cannot be combined in one call.
    resetArgs: [icaclsPath, '/reset', '/q'],
    // Never add /c: it makes icacls exit 0 on "Failed processing 1 files", a silent no-op by another route.
    grantArgs: [
      icaclsPath,
      '/inheritance:r',
      ...allowedSids.flatMap((sid) => ['/grant:r', `*${sid}:${rights}`]),
      '/q'
    ]
  }
}

function verifyArgs(plan: AclPlan, savePath: string): string[] {
  return [plan.icaclsPath, '/save', savePath, '/q']
}

function sddlSavePath(): string {
  return join(tmpdir(), `orca-acl-${process.pid}-${randomBytes(6).toString('hex')}.sddl`)
}

/**
 * Judges a `/save` result. Returns a failure reason, or null when the DACL on disk is exactly the
 * intended one — protected, granting full control to the allowed SIDs and to nobody else.
 */
function evaluateSavedAcl(
  plan: AclPlan,
  result: { code: number | null; stderr: string },
  savePath: string
): string | null {
  if (result.code !== 0) {
    return result.stderr.trim() || `icacls exited ${result.code}`
  }
  let sddl: string
  try {
    // icacls writes the descriptor as UTF-16LE, which sidesteps the OEM codepage its stdout uses.
    sddl = readFileSync(savePath, 'utf16le')
  } catch {
    return 'icacls saved no security descriptor'
  }
  return validateHardenedDacl(sddl, plan)
}

function validateHardenedDacl(sddl: string, plan: AclPlan): string | null {
  const dacl = parseSddlDacl(sddl, plan.localDomainSid ?? undefined)
  if (!dacl) {
    return 'no DACL in the saved security descriptor'
  }
  if (!dacl.isProtected) {
    return 'DACL is not protected; the parent still propagates into it'
  }
  // Exactly these, in any order: a directory's rules must be inheritable and nothing else.
  const expectedFlags = plan.isDirectory ? ['OI', 'CI'] : []
  const observed = new Set<string>()
  for (const ace of dacl.aces) {
    if (ace.type !== 'A') {
      return `unexpected ${ace.type} rule for ${ace.sid}`
    }
    if (ace.flags.includes('ID')) {
      return `inherited rule survived for ${ace.sid}`
    }
    if (ace.rights !== 'FA') {
      return `rule for ${ace.sid} grants ${ace.rights || 'nothing'}, not full control`
    }
    // The whole set, not just OI. (OI) without (CI) leaves subdirectories unprotected, and
    // adding (IO) makes every rule inherit-only, so the directory object itself grants nobody
    // anything and Orca cannot even write into it. Both used to be repaired blindly on every
    // pass; since hardening short-circuits on a DACL that verifies, whatever this accepts stays.
    if (
      ace.flags.length !== expectedFlags.length ||
      !expectedFlags.every((flag) => ace.flags.includes(flag))
    ) {
      return `wrong inheritance flags (${ace.flags.join('') || 'none'}) for ${ace.sid}`
    }
    observed.add(ace.sid)
  }
  // Identity, not just shape: a count check alone accepts a granted SID swapped for another.
  // Unexpected principals are reported before missing ones — "Everyone has full control" is the
  // headline, and a substitution always produces both.
  for (const sid of observed) {
    if (!plan.allowedSids.includes(sid)) {
      return `unexpected rule for ${sid}`
    }
  }
  for (const sid of plan.allowedSids) {
    if (!observed.has(sid)) {
      return `missing rule for ${sid}`
    }
  }
  return null
}

/**
 * icacls resolves through the MAX_PATH-limited API and fails with "cannot find the path
 * specified" past 259 characters; the extended prefix is the documented escape.
 */
function toIcaclsPath(targetPath: string): string {
  if (targetPath.length < 260 || targetPath.startsWith('\\\\?\\')) {
    return targetPath
  }
  const normalized = pathWin32.normalize(targetPath)
  if (/^[A-Za-z]:\\/.test(normalized)) {
    return `\\\\?\\${normalized}`
  }
  if (normalized.startsWith('\\\\')) {
    return `\\\\?\\UNC\\${normalized.slice(2)}`
  }
  return targetPath
}

function report(
  targetPath: string,
  stage: SecurePathHardeningReport['stage'],
  detail: string
): void {
  reportSecurePathHardening(targetPath, stage, detail)
}

/**
 * Applies the ACL without blocking. `onSettled` reports the real outcome, which the return value
 * cannot: the caller's cache must not keep claiming a path is hardened when the apply failed.
 */
export function bestEffortRestrictWindowsPath(
  targetPath: string,
  isDirectory: boolean,
  onSettled?: (restricted: boolean) => void
): void {
  const plan = planFor(targetPath, isDirectory)
  if (!plan) {
    onSettled?.(false)
    return
  }
  // Why async: hardening runs on the read path, and blocking it on a spawn stormed the main thread (#4901).
  // Why both arms and a terminal catch: a bare `void p.then(fn)` makes a rejected `restrictAsync`
  // *and* a throw from `onSettled` itself an unhandled rejection, which Node's default turns into
  // a main-process crash — the exact opposite of what the reporter hook exists for. `false` is the
  // right value on the error arm: it drops the path from the caller's cache and leaves it retryable.
  void restrictAsync(targetPath, plan)
    .then(onSettled, () => onSettled?.(false))
    .catch((error: unknown) => reportSettlementThrow(targetPath, error))
}

/**
 * The last frame before an unhandled rejection, so it must not throw either — and the reporter it
 * calls is a caller-installed hook, which is the one thing here that plausibly does.
 */
function reportSettlementThrow(targetPath: string, error: unknown): void {
  try {
    report(targetPath, 'settle', `hardening settlement callback threw: ${String(error)}`)
  } catch {
    // Nothing left to report through; losing one diagnostic beats crashing the main process.
  }
}

async function restrictAsync(targetPath: string, plan: AclPlan): Promise<boolean> {
  // Verify first: a path that already reads back correct needs no write at all. Re-running
  // `/reset` on a correct DACL would briefly restore the inherited (broader) one for no gain.
  if ((await verifyAsync(plan)) === null) {
    return true
  }
  for (const [stage, args] of [
    ['reset', plan.resetArgs],
    ['grant', plan.grantArgs]
  ] as const) {
    try {
      const result = await runProcess({ program: plan.program, args, timeoutMs: ACL_TIMEOUT_MS })
      if (result.code !== 0) {
        report(targetPath, stage, result.stderr || `icacls exited ${result.code}`)
        return false
      }
    } catch (error) {
      report(targetPath, stage, String(error))
      return false
    }
  }
  const invalid = await verifyAsync(plan)
  if (invalid) {
    report(targetPath, 'verify', invalid)
    return false
  }
  return true
}

async function verifyAsync(plan: AclPlan): Promise<string | null> {
  const savePath = sddlSavePath()
  try {
    const result = await runProcess({
      program: plan.program,
      args: verifyArgs(plan, savePath),
      timeoutMs: ACL_TIMEOUT_MS
    })
    return evaluateSavedAcl(plan, result, savePath)
  } catch (error) {
    return String(error)
  } finally {
    discard(savePath)
  }
}

export function restrictWindowsPathSync(targetPath: string, isDirectory: boolean): boolean {
  const plan = planFor(targetPath, isDirectory)
  if (!plan) {
    return false
  }
  // Why sync: the file must not be published until its ACL is actually restricted (read path stays async, #4901).
  if (verifySync(plan) === null) {
    return true
  }
  for (const [stage, args] of [
    ['reset', plan.resetArgs],
    ['grant', plan.grantArgs]
  ] as const) {
    try {
      const result = runProcessSync({ program: plan.program, args, timeoutMs: ACL_TIMEOUT_MS })
      if (result.code !== 0) {
        report(targetPath, stage, result.stderr || `icacls exited ${result.code}`)
        return false
      }
    } catch (error) {
      // Why not fatal: a failed ACL apply must not crash the write; false leaves the path uncached to retry later.
      report(targetPath, stage, String(error))
      return false
    }
  }
  const invalid = verifySync(plan)
  if (invalid) {
    report(targetPath, 'verify', invalid)
    return false
  }
  return true
}

function verifySync(plan: AclPlan): string | null {
  const savePath = sddlSavePath()
  try {
    const result = runProcessSync({
      program: plan.program,
      args: verifyArgs(plan, savePath),
      timeoutMs: ACL_TIMEOUT_MS
    })
    return evaluateSavedAcl(plan, result, savePath)
  } catch (error) {
    return String(error)
  } finally {
    discard(savePath)
  }
}

function discard(savePath: string): void {
  try {
    rmSync(savePath, { force: true })
  } catch {
    // The descriptor holds no secrets; a leftover temp file is not worth reporting.
  }
}

function planFor(targetPath: string, isDirectory: boolean): AclPlan | null {
  const currentUserSid = getCurrentWindowsUserSid()
  if (!currentUserSid) {
    report(targetPath, 'sid-lookup', 'could not resolve the current user SID')
    return null
  }
  return buildAclPlan(targetPath, currentUserSid, isDirectory)
}

let cachedWindowsUserSid: string | null = null
let sidLookupFailedAt: number | null = null
const SID_LOOKUP_RETRY_MS = 60_000

/**
 * Why monotonic and not `Date.now`: a backwards wall-clock step held this window open until the
 * clock caught up, and this latch is worse than the read-path budget's — a failed lookup makes
 * `planFor` return null, which disables the synchronous *write* path too, so the write-path
 * exemption that recovers from that one cannot recover from this.
 */
const monotonicNowMs = (): number => performance.now()

/**
 * Only a well-formed SID is cached for the process lifetime. A failure is cached for a minute:
 * caching it forever let one transient `whoami` hiccup disable hardening until restart.
 */
function getCurrentWindowsUserSid(): string | null {
  if (cachedWindowsUserSid) {
    return cachedWindowsUserSid
  }
  if (sidLookupFailedAt !== null && monotonicNowMs() - sidLookupFailedAt < SID_LOOKUP_RETRY_MS) {
    return null
  }
  try {
    const result = runProcessSync({
      program: windowsSystem32Binary('whoami.exe'),
      args: ['/user', '/fo', 'csv', '/nh'],
      timeoutMs: ACL_TIMEOUT_MS
    })
    const candidate = result.code === 0 ? parseCsvLine(result.stdout.trim())[1] : undefined
    if (candidate && WINDOWS_SID_PATTERN.test(candidate)) {
      cachedWindowsUserSid = candidate
      sidLookupFailedAt = null
      return candidate
    }
  } catch {
    // Fall through to the failure record below.
  }
  sidLookupFailedAt = monotonicNowMs()
  return null
}

function parseCsvLine(line: string): string[] {
  return line.split(/","/).map((part) => part.replace(/^"/, '').replace(/"$/, ''))
}

export function resetSecureFileWindowsUserSidForTests(): void {
  cachedWindowsUserSid = null
  sidLookupFailedAt = null
}
