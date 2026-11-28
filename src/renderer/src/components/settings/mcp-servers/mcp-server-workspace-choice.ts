// A server's Workspaces checklist over its stored `{later, on, off}`: the server page's checkboxes and
// a repo's switch both change it through here, so the two always agree.
import type { McpServerWorkspaces } from '../../../../../shared/mcp-servers/mcp-servers'

export function isMcpWorkspaceOn(workspaces: McpServerWorkspaces, key: string): boolean {
  return workspaces.on.includes(key) || (workspaces.later && !workspaces.off.includes(key))
}

/** Drops entries that only repeat what `later` already says, so one choice has one encoding. */
function normalized(later: boolean, on: readonly string[], off: readonly string[]) {
  return {
    later,
    on: later ? [] : [...new Set(on)],
    off: later ? [...new Set(off)] : []
  }
}

/** `key` turned on or off; every other workspace keeps what it had. */
export function withMcpWorkspace(
  workspaces: McpServerWorkspaces,
  key: string,
  enabled: boolean
): McpServerWorkspaces {
  const on = workspaces.on.filter((entry) => entry !== key)
  const off = workspaces.off.filter((entry) => entry !== key)
  return normalized(workspaces.later, enabled ? [...on, key] : on, enabled ? off : [...off, key])
}

/**
 * "Workspaces added later" flipped. The workspaces the host has now keep their state, written out,
 * since until now some were on or off only by `later`.
 */
export function withMcpWorkspacesLater(
  workspaces: McpServerWorkspaces,
  known: readonly string[],
  later: boolean
): McpServerWorkspaces {
  const on = known.filter((key) => isMcpWorkspaceOn(workspaces, key))
  const off = known.filter((key) => !isMcpWorkspaceOn(workspaces, key))
  return normalized(later, on, off)
}

export type McpWorkspacesSummary =
  | { kind: 'all' }
  | { kind: 'none' }
  | { kind: 'all-but'; names: string[] }
  | { kind: 'only'; names: string[] }

/** How the checklist reads, over the workspaces the host has now (`known`, by key and name). */
export function summarizeMcpWorkspaces(
  workspaces: McpServerWorkspaces,
  known: readonly { key: string; name: string }[]
): McpWorkspacesSummary {
  const on = known.filter(({ key }) => isMcpWorkspaceOn(workspaces, key))
  if (workspaces.later) {
    const off = known.filter(({ key }) => !isMcpWorkspaceOn(workspaces, key))
    return off.length === 0 ? { kind: 'all' } : { kind: 'all-but', names: off.map((w) => w.name) }
  }
  return on.length === 0 ? { kind: 'none' } : { kind: 'only', names: on.map((w) => w.name) }
}
