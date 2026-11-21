import { access } from 'node:fs/promises'
import { basename, dirname, resolve, sep } from 'node:path'
import { WorkspaceCopyError } from './workspace-copy-errors'
import type { WorkspaceCopyHost } from './workspace-copy-host'
import { ownMarkerPathCandidate } from './workspace-copy-names'
import { p4Tagged } from './workspace-copy-p4'

export type CopySource = {
  client: string
  root: string
  /** Empty for a classic (non-stream) client. */
  stream: string
  user: string
  configPath: string
  configName: string
}

export function normalizePath(path: string): string {
  const full = resolve(path)
  return full.length > 1 && full.endsWith(sep) && dirname(full) !== full ? full.slice(0, -1) : full
}

function comparable(path: string): string {
  const normalized = normalizePath(path)
  // Why: Windows and macOS volumes are case-insensitive by default; p4 reports roots as configured.
  return process.platform === 'linux' ? normalized : normalized.toLowerCase()
}

export function isPathUnder(child: string, parent: string): boolean {
  const c = comparable(child)
  const p = comparable(parent)
  return c === p || c.startsWith(p.endsWith(sep) ? p : `${p}${sep}`)
}

export function samePath(a: string, b: string): boolean {
  return comparable(a) === comparable(b)
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export const P4CLIENT_FROM_CONFIG = /^P4CLIENT=(\S+)\s+\(config '([^']+)'\s*\)/

/**
 * The workspace `dir` belongs to, refusing unless its client is named by a P4CONFIG file inside the
 * client root: every copy rebinds through that file, and it guarantees we act on the folder's own client.
 */
export async function resolveCopySource(host: WorkspaceCopyHost, dir: string): Promise<CopySource> {
  const set = await host.p4(['set', 'P4CLIENT'], { cwd: dir })
  const line = set.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith('P4CLIENT='))
  if (!line) {
    throw new WorkspaceCopyError(
      'refused',
      'P4CLIENT is not set here. Copies need the workspace to name its client in a P4CONFIG file (for example p4config.txt containing P4CLIENT=<client>).'
    )
  }
  const match = P4CLIENT_FROM_CONFIG.exec(line)
  if (!match) {
    throw new WorkspaceCopyError(
      'refused',
      `P4CLIENT does not come from a P4CONFIG file (${line}). Copies need one inside the workspace so each copy can name its own client.`
    )
  }
  const client = match[1]
  const info = (await p4Tagged(host, ['-c', client, 'info'], dir))[0]
  if (!info?.clientRoot || !info.clientName || info.clientName === '*unknown*') {
    throw new WorkspaceCopyError('refused', `Client ${client} does not exist on the server.`)
  }
  const root = normalizePath(info.clientRoot)
  const configPath = normalizePath(match[2])
  if (!isPathUnder(dirname(configPath), root)) {
    throw new WorkspaceCopyError(
      'refused',
      `P4CLIENT comes from ${configPath}, which is outside the client root ${root}. Refusing, so Orca cannot act on a different workspace.`
    )
  }
  return {
    client,
    root,
    stream: info.clientStream ?? '',
    user: info.userName ?? '',
    configPath,
    configName: basename(configPath)
  }
}

/** The marker path when `root` is itself a copy, otherwise null. */
export async function findOwnMarker(root: string): Promise<string | null> {
  const candidate = ownMarkerPathCandidate(root)
  return candidate && (await pathExists(candidate)) ? candidate : null
}
