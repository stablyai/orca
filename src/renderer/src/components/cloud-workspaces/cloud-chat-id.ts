// A chat's id that every device paired with the same cloud workspace agrees on, for presence
// ("Bob is in this chat"), chat links and following a teammate. Tab ids are per device, so the id
// names what the tab shows instead: `s:<structured session id>` or `t:<remote terminal handle>`.
// The control plane accepts 1-128 chars of [A-Za-z0-9_.:-]; other values are base64url-encoded
// under `sb:` / `tb:`, and anything still too long has no shareable id.
import { base64ToBytes, bytesToBase64 } from '../../../../shared/cloud-workspaces/sealed-grant'
import type { Tab } from '../../../../shared/tab-types'

export type CloudChatRef = { kind: 'session' | 'terminal'; id: string }

/** The slice of a terminal tab's layout that names which PTY each pane shows. */
export type CloudChatTerminalLayout = {
  activeLeafId?: string | null
  ptyIdsByLeafId?: Record<string, string>
}

export type CloudChatTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'terminal'; tab: Tab; leafId: string }

const MAX_LENGTH = 128
const SAFE = /^[A-Za-z0-9_.:-]+$/
const PREFIX = { session: 's', terminal: 't' } as const

function toBase64Url(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function fromBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return null
  }
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  try {
    const bytes = base64ToBytes(padded + '='.repeat((4 - (padded.length % 4)) % 4))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

export function encodeCloudChatId(ref: CloudChatRef): string | null {
  if (!ref.id) {
    return null
  }
  const prefix = PREFIX[ref.kind]
  const encoded = SAFE.test(ref.id) ? `${prefix}:${ref.id}` : `${prefix}b:${toBase64Url(ref.id)}`
  return encoded.length <= MAX_LENGTH ? encoded : null
}

export function parseCloudChatId(chatId: string): CloudChatRef | null {
  const match = /^(s|t)(b?):(.+)$/.exec(chatId)
  if (!match || chatId.length > MAX_LENGTH) {
    return null
  }
  const kind = match[1] === 's' ? 'session' : 'terminal'
  const id = match[2] ? fromBase64Url(match[3]!) : match[3]!
  return id ? { kind, id } : null
}

/** The chat a tab shows: its structured session, or the terminal in its focused pane. */
export function cloudChatIdForTab(
  tab: Tab | null,
  layout: CloudChatTerminalLayout | undefined,
  handleOf: (ptyId: string) => string | null
): string | null {
  if (!tab) {
    return null
  }
  if (tab.contentType === 'agent-session') {
    return encodeCloudChatId({ kind: 'session', id: tab.entityId })
  }
  if (tab.contentType !== 'terminal' || !layout?.activeLeafId) {
    return null
  }
  const ptyId = layout.ptyIdsByLeafId?.[layout.activeLeafId]
  const handle = ptyId ? handleOf(ptyId) : null
  return handle ? encodeCloudChatId({ kind: 'terminal', id: handle }) : null
}

/** Where a chat id lives among this device's tabs for one workspace, if it is open here. */
export function findCloudChatTarget(
  ref: CloudChatRef,
  tabs: readonly Tab[],
  layoutOf: (tab: Tab) => CloudChatTerminalLayout | undefined,
  handleOf: (ptyId: string) => string | null
): CloudChatTarget | null {
  if (ref.kind === 'session') {
    const tab = tabs.find((t) => t.contentType === 'agent-session' && t.entityId === ref.id)
    return tab ? { kind: 'session', sessionId: tab.entityId } : null
  }
  for (const tab of tabs) {
    if (tab.contentType !== 'terminal') {
      continue
    }
    for (const [leafId, ptyId] of Object.entries(layoutOf(tab)?.ptyIdsByLeafId ?? {})) {
      if (handleOf(ptyId) === ref.id) {
        return { kind: 'terminal', tab, leafId }
      }
    }
  }
  return null
}
