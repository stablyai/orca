import { currentPerforceSettings } from './p4-settings-context'
import type { PerforceDetectResult, PerforceWorkspaceInfo } from './perforce-types'
import { P4NotFoundError, runP4 } from './p4-command'
import { parseTaggedOutput, type P4Record } from './p4-tagged-output'
import {
  forgetDiscoveredClientsCovering,
  isInsideRoot,
  pickClientForFolder,
  rememberDiscoveredClient
} from './perforce-discovered-clients'

const DETECT_CACHE_TTL_MS = 15_000
// Short, so a fresh `p4 set` or login shows soon, while saves and diffs in other folders stop
// starting a `p4 info` (up to a 15 s timeout) on every call.
const NEGATIVE_DETECT_CACHE_TTL_MS = 5_000
// Why: non-Perforce folders reach the client listing on every negative check; new workspaces are rare.
const CLIENT_LIST_CACHE_TTL_MS = 60_000

const detectCache = new Map<string, { at: number; result: PerforceDetectResult }>()
const clientListCache = new Map<string, { at: number; clients: P4Record[] }>()

export function clearPerforceDetectCache(): void {
  detectCache.clear()
  clientListCache.clear()
}

export function toPosix(path: string): string {
  return path.replaceAll('\\', '/')
}

function toInfo(record: P4Record): PerforceWorkspaceInfo {
  return {
    client: record.clientName ?? '',
    user: record.userName ?? '',
    port: record.serverAddress ?? '',
    root: record.clientRoot ?? ''
  }
}

async function readInfo(cwd: string): Promise<P4Record | null> {
  const result = await runP4(['-ztag', 'info'], { cwd, timeoutMs: 15_000 })
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'p4 info failed')
  }
  return parseTaggedOutput(result.stdout)[0] ?? null
}

async function listUserClients(cwd: string, record: P4Record): Promise<P4Record[]> {
  const user = record.userName ?? ''
  const key = `${record.serverAddress ?? ''}|${user}`
  const cached = clientListCache.get(key)
  if (cached && Date.now() - cached.at < CLIENT_LIST_CACHE_TTL_MS) {
    return cached.clients
  }
  const result = await runP4(['-ztag', 'clients', '-u', user], { cwd, timeoutMs: 15_000 })
  const clients = result.code === 0 ? parseTaggedOutput(result.stdout) : []
  clientListCache.set(key, { at: Date.now(), clients })
  return clients
}

/** Finds the client for a folder no P4CONFIG file or P4CLIENT names, by matching client roots on this host. */
async function discoverClient(cwd: string, record: P4Record): Promise<PerforceDetectResult> {
  if (!record.userName || !record.clientHost || currentPerforceSettings().p4Client) {
    return { isWorkspace: false, reason: 'not-in-workspace' }
  }
  const found = pickClientForFolder(await listUserClients(cwd, record), cwd, record.clientHost)
  if (found.kind === 'ambiguous') {
    return {
      isWorkspace: false,
      reason: 'not-in-workspace',
      message: `Clients ${found.clients.join(', ')} all have this folder as their root. Name one in a P4CONFIG file here.`
    }
  }
  if (found.kind === 'none') {
    return { isWorkspace: false, reason: 'not-in-workspace' }
  }
  rememberDiscoveredClient(found.root, found.client)
  const confirmed = await readInfo(cwd)
  if (confirmed?.clientName !== found.client || !confirmed.clientRoot) {
    forgetDiscoveredClientsCovering(found.root)
    return { isWorkspace: false, reason: 'not-in-workspace' }
  }
  return { isWorkspace: true, info: toInfo(confirmed) }
}

async function detectUncached(cwd: string): Promise<PerforceDetectResult> {
  try {
    const record = await readInfo(cwd)
    const info = record ? toInfo(record) : null
    if (info?.client && info.client !== '*unknown*' && info.root && isInsideRoot(cwd, info.root)) {
      return { isWorkspace: true, info }
    }
    // Why: a remembered client that no longer covers the folder (deleted, root moved) must not stick.
    forgetDiscoveredClientsCovering(cwd)
    return record
      ? await discoverClient(cwd, record)
      : { isWorkspace: false, reason: 'not-in-workspace' }
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
  const ttl = cached?.result.isWorkspace ? DETECT_CACHE_TTL_MS : NEGATIVE_DETECT_CACHE_TTL_MS
  if (cached && Date.now() - cached.at < ttl) {
    return cached.result
  }
  const result = await detectUncached(cwd)
  detectCache.set(cwd, { at: Date.now(), result })
  return result
}

export async function isPerforceWorkspace(cwd: string): Promise<boolean> {
  return (await detectPerforceWorkspace(cwd)).isWorkspace
}
