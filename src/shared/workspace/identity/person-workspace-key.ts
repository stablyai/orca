// A teammate's own workspace in a shared agent's Home: one per (Home, person), kept on the agent's
// host and never sent to any client, which addresses the Home itself (`folder:<id>`).
import { folderWorkspaceKey, type WorkspaceKey } from './workspace-scope'

export type PersonWorkspaceKey = `person:${string}`

export type PersonWorkspaceRef = { folderWorkspaceId: string; botId: string; accountId: string }

const PREFIX = 'person:'

export function personWorkspaceKey(ref: PersonWorkspaceRef): PersonWorkspaceKey {
  const parts = [ref.folderWorkspaceId, ref.botId, ref.accountId].map(encodeURIComponent)
  return `${PREFIX}${parts.join(':')}`
}

export function parsePersonWorkspaceKey(value: string): PersonWorkspaceRef | null {
  if (!value.startsWith(PREFIX)) {
    return null
  }
  const parts = value.slice(PREFIX.length).split(':')
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    return null
  }
  try {
    const [folderWorkspaceId, botId, accountId] = parts.map(decodeURIComponent)
    return { folderWorkspaceId: folderWorkspaceId!, botId: botId!, accountId: accountId! }
  } catch {
    return null
  }
}

export function isPersonWorkspaceKey(
  value: string | null | undefined
): value is PersonWorkspaceKey {
  return typeof value === 'string' && parsePersonWorkspaceKey(value) !== null
}

/** The Home whose folder, files and git a person's workspace shows. */
export function homeOfPersonWorkspace(key: PersonWorkspaceKey): WorkspaceKey | null {
  const ref = parsePersonWorkspaceKey(key)
  return ref ? folderWorkspaceKey(ref.folderWorkspaceId) : null
}
