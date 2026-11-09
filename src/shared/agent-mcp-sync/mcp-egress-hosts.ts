import type { McpSyncServerRow } from './mcp-sync-contract'

/** The control plane's per-sandbox ceiling on extra egress hosts (sandbox-control egress-hosts.ts). */
export const MCP_EGRESS_MAX_HOSTS = 32

// Mirrors the control plane's check: public DNS names only. Anything else would fail the whole PUT.
const PUBLIC_HOST = /^([a-z0-9-]+\.)+[a-z]{2,63}$/
const PRIVATE_SUFFIXES = [
  '.local',
  '.localhost',
  '.internal',
  '.lan',
  '.home',
  '.corp',
  '.intranet'
]

export function publicEgressHost(value: string): string | null {
  const host = value.trim().toLowerCase().replace(/\.$/, '')
  return PUBLIC_HOST.test(host) && !PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))
    ? host
    : null
}

/** Hostnames of the remote servers this sync sends; the sandbox's allowlist has to admit them. */
export function mcpEgressHostsOf(rows: readonly McpSyncServerRow[]): string[] {
  const hosts = new Set<string>()
  for (const row of rows) {
    if (row.state !== 'pending' || row.transport === 'stdio' || !row.target) {
      continue
    }
    try {
      const host = publicEgressHost(new URL(row.target).hostname)
      if (host) {
        hosts.add(host)
      }
    } catch {
      // A target that is not a URL has no host to open.
    }
  }
  return [...hosts].sort()
}

export type EgressHostMerge = {
  /** The sandbox's full list to PUT. */
  hosts: string[]
  /** The hosts MCP sync added and may later take back. */
  owned: string[]
  /** Wanted hosts that did not fit under the ceiling. */
  dropped: string[]
}

/**
 * Hosts other tools declared stay; only hosts MCP sync added earlier and no longer needs are
 * removed. New hosts fill the remaining room in name order.
 */
export function mergeMcpEgressHosts(input: {
  current: readonly string[]
  owned: readonly string[]
  wanted: readonly string[]
  max?: number
}): EgressHostMerge {
  const max = input.max ?? MCP_EGRESS_MAX_HOSTS
  const wanted = new Set(input.wanted)
  const owned = new Set(input.owned)
  const kept = input.current.filter((host) => !owned.has(host) || wanted.has(host))
  const keptSet = new Set(kept)
  const additions = [...wanted].filter((host) => !keptSet.has(host)).sort()
  const room = Math.max(0, max - kept.length)
  const added = additions.slice(0, room)
  const hosts = [...new Set([...kept, ...added])].sort()
  const nextOwned = hosts.filter(
    (host) => wanted.has(host) && (owned.has(host) || added.includes(host))
  )
  return { hosts, owned: nextOwned, dropped: additions.slice(room) }
}
