import { resolve } from 'node:path'
import type { P4Record } from './p4-tagged-output'

function normalizeForCompare(path: string): string {
  const posix = resolve(path).replaceAll('\\', '/').replace(/\/+$/, '')
  // Why: macOS and Windows default to case-insensitive volumes, and p4 reports the client root as configured.
  return process.platform === 'linux' ? posix : posix.toLowerCase()
}

export function isInsideRoot(cwd: string, root: string): boolean {
  const cwdKey = normalizeForCompare(cwd)
  const rootKey = normalizeForCompare(root)
  return cwdKey === rootKey || cwdKey.startsWith(`${rootKey}/`)
}

export type ClientDiscovery =
  | { kind: 'found'; client: string; root: string }
  | { kind: 'none' }
  | { kind: 'ambiguous'; clients: string[] }

/**
 * Picks the client from a `p4 clients` listing whose root holds `cwd` on this host: the deepest
 * root wins, and two clients sharing it are refused rather than guessed between.
 */
export function pickClientForFolder(
  clients: readonly P4Record[],
  cwd: string,
  host: string
): ClientDiscovery {
  const hostKey = host.toLowerCase()
  const matches = clients.filter((record) => {
    const root = record.Root
    const clientHost = (record.Host ?? '').toLowerCase()
    return (
      record.client &&
      root &&
      root !== 'null' &&
      (clientHost === '' || clientHost === hostKey) &&
      isInsideRoot(cwd, root)
    )
  })
  if (matches.length === 0) {
    return { kind: 'none' }
  }
  const depth = (record: P4Record): number => normalizeForCompare(record.Root).length
  const deepest = Math.max(...matches.map(depth))
  const best = matches.filter((record) => depth(record) === deepest)
  if (best.length > 1) {
    return { kind: 'ambiguous', clients: best.map((record) => record.client) }
  }
  return { kind: 'found', client: best[0].client, root: best[0].Root }
}

// Why: a folder whose client is not named by a P4CONFIG file (or P4CLIENT) is found by its root;
// every later p4 call under that root must then name the same client.
const discovered = new Map<string, { root: string; client: string }>()

export function rememberDiscoveredClient(root: string, client: string): void {
  discovered.set(normalizeForCompare(root), { root, client })
}

export function forgetDiscoveredClientsCovering(cwd: string): void {
  for (const [key, entry] of discovered) {
    if (isInsideRoot(cwd, entry.root)) {
      discovered.delete(key)
    }
  }
}

/** The discovered client whose root holds `cwd` (deepest root first), if any. */
export function discoveredClientFor(cwd: string): string | null {
  let best: { root: string; client: string } | null = null
  for (const entry of discovered.values()) {
    if (isInsideRoot(cwd, entry.root) && (!best || entry.root.length > best.root.length)) {
      best = entry
    }
  }
  return best?.client ?? null
}
