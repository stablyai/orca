// A chat's id in an orca://cloud link, the same on every device paired with the workspace. Tab ids
// are per device, so the id names what the tab shows instead: `s:<structured session id>` or
// `t:<remote terminal handle>`, in 1-128 chars of [A-Za-z0-9_.:-]; other values are
// base64url-encoded under `sb:` / `tb:`. Opening a link routes its chat id to the tab showing it.
import { base64ToBytes } from '../../../../shared/cloud-workspaces/sealed-grant'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'

type CloudChatRef = { kind: 'session' | 'terminal'; id: string }

/** The slice of a terminal tab's layout that names which PTY each pane shows. */
export type CloudChatTerminalLayout = {
  activeLeafId?: string | null
  ptyIdsByLeafId?: Record<string, string>
}

export type CloudChatTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'terminal'; tab: Tab; leafId: string }

const MAX_LENGTH = 128
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

export function parseCloudChatId(chatId: string): CloudChatRef | null {
  const match = /^(s|t)(b?):(.+)$/.exec(chatId)
  if (!match || chatId.length > MAX_LENGTH) {
    return null
  }
  const kind = match[1] === 's' ? 'session' : 'terminal'
  const id = match[2] ? fromBase64Url(match[3]!) : match[3]!
  return id ? { kind, id } : null
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
