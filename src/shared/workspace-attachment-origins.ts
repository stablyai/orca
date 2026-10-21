import type { WorkspaceAttachmentOrigin } from './worktree/types'
import { parseExecutionHostId } from './execution-host'

export function getWorkspaceAttachmentOriginKey(origin: WorkspaceAttachmentOrigin): string {
  return JSON.stringify([
    origin.hostId ?? '',
    origin.tabId,
    origin.paneKey ?? '',
    origin.agent ?? '',
    origin.sessionId ?? '',
    origin.kind
  ])
}

function originText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= 512 ? value.trim() : undefined
}

export function normalizeWorkspaceAttachmentOrigins(value: unknown): WorkspaceAttachmentOrigin[] {
  if (!Array.isArray(value)) {
    return []
  }
  const origins = new Map<string, WorkspaceAttachmentOrigin>()
  for (const candidate of value.slice(0, 128)) {
    if (!candidate || typeof candidate !== 'object') {
      continue
    }
    const raw: Record<string, unknown> = Object.fromEntries(Object.entries(candidate))
    const tabId = originText(raw.tabId)
    const hostId = parseExecutionHostId(originText(raw.hostId))?.id
    if ((raw.hostId !== undefined && !hostId) || !tabId || raw.kind !== 'observed') {
      continue
    }
    const origin: WorkspaceAttachmentOrigin = {
      kind: raw.kind,
      tabId,
      ...(originText(raw.paneKey) ? { paneKey: originText(raw.paneKey) } : {}),
      ...(hostId ? { hostId } : {}),
      ...(originText(raw.label) ? { label: originText(raw.label) } : {}),
      ...(originText(raw.agent) ? { agent: originText(raw.agent) } : {}),
      ...(originText(raw.sessionId) ? { sessionId: originText(raw.sessionId) } : {})
    }
    origins.set(getWorkspaceAttachmentOriginKey(origin), origin)
  }
  return [...origins.values()]
}

export function mergeWorkspaceAttachmentOrigins(
  current: WorkspaceAttachmentOrigin[] | undefined,
  incoming: WorkspaceAttachmentOrigin[] | undefined
): WorkspaceAttachmentOrigin[] {
  return normalizeWorkspaceAttachmentOrigins([...(current ?? []), ...(incoming ?? [])])
}

export function rebaseWorkspaceAttachmentOrigins(
  current: WorkspaceAttachmentOrigin[] | undefined,
  base: WorkspaceAttachmentOrigin[] | undefined,
  requested: WorkspaceAttachmentOrigin[] | undefined
): WorkspaceAttachmentOrigin[] {
  const requestedKeys = new Set((requested ?? []).map(getWorkspaceAttachmentOriginKey))
  const removed = new Set(
    (base ?? []).map(getWorkspaceAttachmentOriginKey).filter((key) => !requestedKeys.has(key))
  )
  return mergeWorkspaceAttachmentOrigins(
    (current ?? []).filter((origin) => !removed.has(getWorkspaceAttachmentOriginKey(origin))),
    requested
  )
}
