import type { AppState } from '@/store/types'
import type { Tab } from '../../../shared/tab-types'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionOwnerInputs
} from './structured-agent-session-owner'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../shared/structured-agent-session-projection'
import { toHostSessionTabId } from '../../../shared/terminal-surface-id'
import { parseRemoteRuntimePtyId } from '../../../shared/remote-runtime/remote-runtime-pty-id'
import { getKnownExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'

const key = (host: string, address: string) => JSON.stringify([host, address])

/** One tab bucket's contribution: host pane -> this window's pane, and chat panes -> their tab. */
type AliasPart = {
  readonly key: string
  readonly visible: readonly (readonly [string, string])[]
  readonly chats: readonly (readonly [string, Tab])[]
}
const memo = new WeakMap<object, { owner: readonly unknown[]; part: AliasPart }>()
const lastByBucket = new Map<string, AliasPart>()
let aliasVisits = 0
export const agentSenderAliasWorkForTest = () => aliasVisits

function part(
  id: string,
  // Terminal and chat buckets have different tab types; only identity and length are read here.
  tabs: readonly unknown[],
  owner: readonly unknown[],
  build: () => Omit<AliasPart, 'key'>
): AliasPart {
  const cached = memo.get(tabs)
  if (cached && cached.owner.every((input, i) => input === owner[i])) {
    return cached.part
  }
  aliasVisits += tabs.length
  const built = build()
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
  memo.set(tabs, { owner, part: result })
  return result
}

/** Each tab bucket's aliases, recomputed only for a bucket whose array or owner inputs changed. */
export function agentSenderAliasParts(state: AppState): readonly AliasPart[] {
  const owner = structuredAgentSessionOwnerInputs(state)
  const parts: AliasPart[] = []
  for (const [worktreeId, tabs] of Object.entries(state.unifiedTabsByWorktree)) {
    parts.push(
      part(`chat:${worktreeId}`, tabs, owner, () => {
        const visible: [string, string][] = []
        const chats: [string, Tab][] = []
        for (const tab of tabs) {
          const host = structuredAgentSessionOwnerForTab(state, tab)
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
      part(`terminal:${worktreeId}`, tabs, owner, () => {
        const visible: [string, string][] = []
        for (const tab of tabs) {
          const remote = tab.ptyId ? parseRemoteRuntimePtyId(tab.ptyId) : null
          const host = remote
            ? `runtime:${remote.environmentId}`
            : getKnownExecutionHostIdForWorktree(state, worktreeId)
          const [hostTab, leafId] = toHostSessionTabId(tab.id).split('::')
          if (host && hostTab && leafId) {
            visible.push([key(host, `${hostTab}:${leafId}`), `${tab.id}:${leafId}`])
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
  return { visible, chatTabs }
}
