import type { AppState } from '@/store/types'
import type { Tab } from '../../../shared/tab-types'
import {
  resolveStructuredAgentSessionOwner,
  structuredAgentSessionOwnerInputs
} from './structured-agent-session-owner'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../shared/structured-agent-session-projection'
import { isWebTerminalSurfaceTabId, toHostSessionTabId } from '../../../shared/terminal-surface-id'
import { parseRemoteRuntimePtyId } from '../../../shared/remote-runtime/remote-runtime-pty-id'
import { getKnownExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { parsePaneKey } from '../../../shared/stable-pane-id'

const key = (host: string, address: string) => JSON.stringify([host, address])

/** One tab bucket's contribution: host pane -> this window's pane, and chat panes -> their tab. */
type AliasPart = {
  readonly key: string
  readonly visible: readonly (readonly [string, string])[]
  readonly chats: readonly (readonly [string, Tab])[]
}
/** A bucket's part, the owner inputs it was last checked against, and the one host value per
 *  worktree it read: owner inputs reach a bucket only through those hosts. */
type Memo = { owner: readonly unknown[]; hosts: Map<string, string | null>; part: AliasPart }
const memo = new WeakMap<object, Memo>()
const lastByBucket = new Map<string, AliasPart>()
let aliasVisits = 0
export const agentSenderAliasWorkForTest = () => aliasVisits

function part(
  id: string,
  // Terminal and chat buckets have different tab types; only identity and length are read here.
  tabs: readonly unknown[],
  owner: readonly unknown[],
  hostOf: (worktreeId: string) => string | null,
  build: (host: (worktreeId: string) => string | null) => Omit<AliasPart, 'key'>
): AliasPart {
  const cached = memo.get(tabs)
  if (cached) {
    // A workspace switch or settings write moves owner inputs; only a host this bucket read
    // changing can change its aliases.
    if (
      cached.owner.every((input, i) => input === owner[i]) ||
      [...cached.hosts].every(([worktreeId, host]) => hostOf(worktreeId) === host)
    ) {
      cached.owner = owner
      return cached.part
    }
  }
  aliasVisits += tabs.length
  const hosts = new Map<string, string | null>()
  const built = build((worktreeId) => {
    if (!hosts.has(worktreeId)) {
      hosts.set(worktreeId, hostOf(worktreeId))
    }
    return hosts.get(worktreeId) ?? null
  })
  const fresh = {
    ...built,
    key: JSON.stringify([
      built.visible,
      built.chats.map(([pane, tab]) => [pane, tab.label, tab.customLabel, tab.agentSessionAgent])
    ])
  }
  // A bucket replaced for a field no sender reads (a title) keeps its part, and so the index.
  const previous = lastByBucket.get(id)
  const result = previous?.key === fresh.key ? previous : fresh
  lastByBucket.set(id, result)
  memo.set(tabs, { owner, hosts, part: result })
  return result
}

/** Each tab bucket's aliases, recomputed only for a bucket whose array or read hosts changed. */
export function agentSenderAliasParts(state: AppState): readonly AliasPart[] {
  const owner = structuredAgentSessionOwnerInputs(state)
  const chatOwner = (worktreeId: string) => resolveStructuredAgentSessionOwner(state, worktreeId)
  const terminalOwner = (worktreeId: string) =>
    getKnownExecutionHostIdForWorktree(state, worktreeId)
  const parts: AliasPart[] = []
  for (const [worktreeId, tabs] of Object.entries(state.unifiedTabsByWorktree)) {
    parts.push(
      part(`chat:${worktreeId}`, tabs, owner, chatOwner, (hostOf) => {
        const visible: [string, string][] = []
        const chats: [string, Tab][] = []
        for (const tab of tabs) {
          // The chat's own recorded host, else its workspace's owner, as the sidebar reads it.
          const host = tab.executionHostId ?? hostOf(tab.worktreeId)
          if (host && tab.contentType === 'agent-session') {
            const pane = structuredAgentSessionPaneKey(tab.id, tab.entityId)
            chats.push([key(host, pane), tab])
            const canonical = structuredAgentSessionTabId(tab.entityId)
            visible.push([key(host, structuredAgentSessionPaneKey(canonical, tab.entityId)), pane])
          }
        }
        return { visible, chats }
      })
    )
  }
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    parts.push(
      part(`terminal:${worktreeId}`, tabs, owner, terminalOwner, (hostOf) => {
        const visible: [string, string][] = []
        for (const tab of tabs) {
          const remote = tab.ptyId ? parseRemoteRuntimePtyId(tab.ptyId) : null
          const host = remote ? `runtime:${remote.environmentId}` : hostOf(worktreeId)
          const [hostTab, leafId] = toHostSessionTabId(tab.id).split('::')
          if (host && hostTab && leafId) {
            visible.push([key(host, `${hostTab}:${leafId}`), `${tab.id}:${leafId}`])
          } else if (host && hostTab && isWebTerminalSurfaceTabId(tab.id)) {
            // A whole-tab mirror keeps the host's leaf ids, so it aliases the host tab itself; a
            // tab id has no ':', so this never collides with a pane's alias.
            visible.push([key(host, hostTab), tab.id])
          }
        }
        return { visible, chats: [] }
      })
    )
  }
  return parts
}

/** The window's alias maps; two buckets naming one host pane differently make it ambiguous. */
export function assembleAgentSenderAliases(parts: readonly AliasPart[]) {
  const visible = new Map<string, string | null>()
  const chatTabs = new Map<string, Tab>()
  for (const { visible: rows, chats } of parts) {
    for (const [id, value] of rows) {
      visible.set(id, visible.has(id) && visible.get(id) !== value ? null : value)
    }
    for (const [id, tab] of chats) {
      chatTabs.set(id, tab)
    }
  }
  /** This window's name for a host's pane: a per-pane alias or its whole-tab mirror's; null when
   *  this window names it two ways, undefined when it names it none. */
  const windowPane = (host: string, hostPane: string): string | null | undefined => {
    const pane = visible.get(key(host, hostPane))
    const parsed = parsePaneKey(hostPane)
    const tab = parsed ? visible.get(key(host, parsed.tabId)) : undefined
    const mirrored = tab && parsed ? `${tab}:${parsed.leafId}` : tab
    if (mirrored === undefined) {
      return pane
    }
    return pane === undefined || pane === mirrored ? mirrored : null
  }
  return { windowPane, chatTabs }
}
