import { resolve } from 'node:path'
import type { PerforceDetectResult, PerforceWorkspaceInfo } from './perforce-types'
import { P4NotFoundError, runP4 } from './p4-command'
import { parseTaggedOutput, type P4Record } from './p4-tagged-output'

const DETECT_CACHE_TTL_MS = 15_000

const detectCache = new Map<string, { at: number; result: PerforceDetectResult }>()

export function clearPerforceDetectCache(): void {
  detectCache.clear()
}

export function toPosix(path: string): string {
  return path.replaceAll('\\', '/')
}

function normalizeForCompare(path: string): string {
  const posix = toPosix(resolve(path)).replace(/\/+$/, '')
  // Why: macOS and Windows default to case-insensitive volumes, and p4 reports the client root as configured.
  return process.platform === 'linux' ? posix : posix.toLowerCase()
}

function isInsideRoot(cwd: string, root: string): boolean {
  const cwdKey = normalizeForCompare(cwd)
  const rootKey = normalizeForCompare(root)
  return cwdKey === rootKey || cwdKey.startsWith(`${rootKey}/`)
}

function toInfo(record: P4Record): PerforceWorkspaceInfo {
  return {
    client: record.clientName ?? '',
    user: record.userName ?? '',
    port: record.serverAddress ?? '',
    root: record.clientRoot ?? ''
  }
}

async function detectUncached(cwd: string): Promise<PerforceDetectResult> {
  try {
    const result = await runP4(['-ztag', 'info'], { cwd, timeoutMs: 15_000 })
    if (result.code !== 0) {
      return { isWorkspace: false, reason: 'error', message: result.stderr.trim() }
    }
    const record = parseTaggedOutput(result.stdout)[0]
    const info = record ? toInfo(record) : null
    if (!info || !info.client || info.client === '*unknown*' || !info.root) {
      return { isWorkspace: false, reason: 'not-in-workspace' }
    }
    if (!isInsideRoot(cwd, info.root)) {
      return { isWorkspace: false, reason: 'not-in-workspace' }
    }
    return { isWorkspace: true, info }
  } catch (error) {
    if (error instanceof P4NotFoundError) {
      return { isWorkspace: false, reason: 'p4-not-found', message: error.message }
    }
    return {
      isWorkspace: false,
      reason: 'error',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

/** Reports whether `cwd` is inside a Perforce client workspace, caching briefly. */
export async function detectPerforceWorkspace(cwd: string): Promise<PerforceDetectResult> {
  const cached = detectCache.get(cwd)
  if (cached && Date.now() - cached.at < DETECT_CACHE_TTL_MS) {
    return cached.result
  }
  const result = await detectUncached(cwd)
  detectCache.set(cwd, { at: Date.now(), result })
  return result
}

export async function isPerforceWorkspace(cwd: string): Promise<boolean> {
  return (await detectPerforceWorkspace(cwd)).isWorkspace
}
