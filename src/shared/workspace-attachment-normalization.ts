import {
  normalizeWorkspaceAttachmentOrigins,
  mergeWorkspaceAttachmentOrigins
} from './workspace-attachment-origins'
import type { WorkspaceAttachment, WorkspaceLinkedItem } from './worktree/types'
import { getTaskSourceCacheScope, normalizeStoredTaskSourceContext } from './task-source-context'
import { normalizeWorkspaceLinkedItem } from './workspace-linked-item'
import { getProvenWorkspaceReferenceIdentity } from './workspace-reference-identity'
import { isWorkspaceLinkedItemSourceContextMatch } from './workspace-linked-item-source-context'

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function normalizeWorkspaceAttachment(value: unknown): WorkspaceAttachment | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const raw: Record<string, unknown> = Object.fromEntries(Object.entries(value))
  const provider = raw.provider
  if (
    provider !== 'github' &&
    provider !== 'gitlab' &&
    provider !== 'linear' &&
    provider !== 'jira' &&
    provider !== 'bitbucket' &&
    provider !== 'azure-devops' &&
    provider !== 'gitea'
  ) {
    return null
  }
  const type = raw.type
  if (type !== 'issue' && type !== 'pr' && type !== 'mr') {
    return null
  }
  if ((provider === 'linear' || provider === 'jira') && type !== 'issue') {
    return null
  }
  if (type === 'mr' && provider !== 'gitlab') {
    return null
  }
  if (typeof raw.number !== 'number' || !Number.isSafeInteger(raw.number) || raw.number < 0) {
    return null
  }
  const identifier =
    nonEmpty(raw.identifier) ?? nonEmpty(raw.linearIdentifier) ?? nonEmpty(raw.jiraIdentifier)
  if (raw.number === 0 && (!identifier || (provider !== 'linear' && provider !== 'jira'))) {
    return null
  }
  if (raw.url !== undefined) {
    try {
      const url = new URL(String(raw.url))
      if (typeof raw.url !== 'string' || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
        return null
      }
    } catch {
      return null
    }
  }
  const item: WorkspaceAttachment = {
    provider,
    type,
    number: raw.number,
    ...(identifier ? { identifier } : {}),
    ...(nonEmpty(raw.title) ? { title: nonEmpty(raw.title) } : {}),
    ...(nonEmpty(raw.url) ? { url: nonEmpty(raw.url) } : {}),
    ...(raw.origins !== undefined
      ? { origins: normalizeWorkspaceAttachmentOrigins(raw.origins) }
      : {}),
    ...(nonEmpty(raw.repoId) ? { repoId: nonEmpty(raw.repoId) } : {}),
    ...(nonEmpty(raw.linearIdentifier) ? { linearIdentifier: nonEmpty(raw.linearIdentifier) } : {}),
    ...(nonEmpty(raw.jiraIdentifier) ? { jiraIdentifier: nonEmpty(raw.jiraIdentifier) } : {}),
    ...(nonEmpty(raw.linearWorkspaceId)
      ? { linearWorkspaceId: nonEmpty(raw.linearWorkspaceId) }
      : {}),
    ...(nonEmpty(raw.linearOrganizationUrlKey)
      ? { linearOrganizationUrlKey: nonEmpty(raw.linearOrganizationUrlKey) }
      : {})
  }
  const context = normalizeStoredTaskSourceContext(raw.taskSourceContext)
  const linkedItem = normalizeWorkspaceLinkedItem({
    ...item,
    title: item.title ?? identifier ?? String(item.number),
    jiraIdentifier: item.jiraIdentifier ?? (provider === 'jira' ? identifier : undefined)
  })
  if (
    context &&
    context.provider === provider &&
    (provider !== 'jira' ||
      (linkedItem && isWorkspaceLinkedItemSourceContextMatch(linkedItem, context)))
  ) {
    item.taskSourceContext = context
  }
  return item
}

function attachmentIdentity(item: WorkspaceAttachment): string {
  return JSON.stringify([
    item.provider,
    item.type,
    item.provider === 'linear' || item.provider === 'jira'
      ? (item.identifier ?? item.linearIdentifier ?? item.jiraIdentifier ?? item.number)
      : item.number
  ])
}

export function getWorkspaceAttachmentKey(item: WorkspaceAttachment): string {
  return JSON.stringify([
    attachmentIdentity(item),
    item.taskSourceContext ? getTaskSourceCacheScope(item.taskSourceContext) : '',
    item.repoId ?? '',
    item.linearWorkspaceId ?? '',
    item.linearOrganizationUrlKey ?? '',
    getWorkspaceAttachmentUrlScope(item)
  ])
}

export function getWorkspaceAttachmentUrlScope(item: WorkspaceAttachment): string {
  if (!item.url) {
    return ''
  }
  try {
    const url = new URL(item.url)
    return (
      url.origin +
      url.pathname
        .replace(
          /\/(?:pull|pulls|issues|merge_requests|pull-requests|pullrequest|browse|issue)\/[^/]+(?:\/.*)?$/,
          ''
        )
        .replace(/\/-$/, '')
    )
  } catch {
    return ''
  }
}

/** One entry per proven external reference and source context; local repo IDs never split it. */
export function getWorkspaceAttachmentDedupeKey(item: WorkspaceAttachment): string {
  const reference = getProvenWorkspaceReferenceIdentity(item)
  return reference
    ? JSON.stringify([
        reference,
        item.taskSourceContext ? getTaskSourceCacheScope(item.taskSourceContext) : ''
      ])
    : getWorkspaceAttachmentKey(item)
}

export function normalizeWorkspaceAttachments(value: unknown): WorkspaceAttachment[] {
  if (!Array.isArray(value)) {
    return []
  }
  const items = new Map<string, WorkspaceAttachment>()
  for (const raw of value) {
    const item = normalizeWorkspaceAttachment(raw)
    if (!item) {
      continue
    }
    const key = getWorkspaceAttachmentDedupeKey(item)
    const previous = items.get(key)
    items.set(key, {
      ...previous,
      ...item,
      // Why: the collapse pass compares repoId, so a conflict must resolve independently of input order.
      ...(previous?.repoId && item.repoId && previous.repoId < item.repoId
        ? { repoId: previous.repoId }
        : {}),
      ...(previous?.origins || item.origins
        ? { origins: mergeWorkspaceAttachmentOrigins(previous?.origins, item.origins) }
        : {})
    })
  }
  const normalized = [...items.values()]
  const groups = new Map<string, WorkspaceAttachment[]>()
  for (const item of normalized) {
    const identity = attachmentIdentity(item)
    const group = groups.get(identity)
    if (group) {
      group.push(item)
    } else {
      groups.set(identity, [item])
    }
  }
  const retained = new Set<WorkspaceAttachment>()
  for (const group of groups.values()) {
    for (const item of group.length === 1 ? group : collapseAttachmentIdentityGroup(group)) {
      retained.add(item)
    }
  }
  return normalized.filter((item) => retained.has(item))
}

function collapseAttachmentIdentityGroup(normalized: WorkspaceAttachment[]): WorkspaceAttachment[] {
  while (true) {
    const absorbers = new Map<WorkspaceAttachment, WorkspaceAttachment>()
    for (const item of normalized) {
      const richer = normalized.filter(
        (candidate) => candidate !== item && absorbsWorkspaceAttachment(candidate, item)
      )
      if (richer.length === 1) {
        absorbers.set(item, richer[0])
      }
    }
    // Mutual absorbers would erase each other, so keep every member of a cycle.
    const cyclic = [...absorbers.keys()].filter((item) => absorberChain(absorbers, item).cyclic)
    for (const item of cyclic) {
      absorbers.delete(item)
    }
    if (absorbers.size === 0) {
      return normalized
    }
    // Fold chain tails first so absorbed data reaches the final survivor, nearer links winning.
    const removed = [...absorbers]
      .map(([candidate, enriched]) => ({
        candidate,
        enriched,
        depth: absorberChain(absorbers, candidate).depth
      }))
      .sort((a, b) => b.depth - a.depth)
    for (const { candidate, enriched } of removed) {
      Object.assign(enriched, {
        ...candidate,
        ...enriched,
        ...(candidate.origins || enriched.origins
          ? { origins: mergeWorkspaceAttachmentOrigins(candidate.origins, enriched.origins) }
          : {})
      })
    }
    normalized = normalized.filter((item) => !absorbers.has(item))
  }
}

function absorberChain(
  absorbers: Map<WorkspaceAttachment, WorkspaceAttachment>,
  item: WorkspaceAttachment
): { depth: number; cyclic: boolean } {
  const seen = new Set<WorkspaceAttachment>([item])
  let current = absorbers.get(item)
  let depth = 1
  while (current && absorbers.has(current)) {
    if (seen.has(current)) {
      return { depth, cyclic: current === item }
    }
    seen.add(current)
    current = absorbers.get(current)
    depth++
  }
  return { depth, cyclic: false }
}

function absorbsWorkspaceAttachment(rich: WorkspaceAttachment, item: WorkspaceAttachment): boolean {
  if (matchesWorkspaceAttachmentIdentity(rich, item)) {
    return true
  }
  // A context-less copy of a proven URL belongs to the unique source that owns that URL.
  const reference = item.taskSourceContext ? undefined : getProvenWorkspaceReferenceIdentity(item)
  return reference !== undefined && reference === getProvenWorkspaceReferenceIdentity(rich)
}

export function matchesWorkspaceAttachmentIdentity(
  item: WorkspaceAttachment,
  legacy: WorkspaceAttachment
): boolean {
  if (attachmentIdentity(item) !== attachmentIdentity(legacy)) {
    return false
  }
  if (legacy.taskSourceContext) {
    return getWorkspaceAttachmentKey(item) === getWorkspaceAttachmentKey(legacy)
  }
  if (
    legacy.url &&
    getWorkspaceAttachmentUrlScope(item) !== getWorkspaceAttachmentUrlScope(legacy)
  ) {
    return false
  }
  return (
    (!legacy.repoId || item.repoId === legacy.repoId) &&
    (!legacy.linearWorkspaceId || item.linearWorkspaceId === legacy.linearWorkspaceId) &&
    (!legacy.linearOrganizationUrlKey ||
      item.linearOrganizationUrlKey === legacy.linearOrganizationUrlKey)
  )
}

export function toWorkspaceLinkedItem(
  item: WorkspaceAttachment | undefined
): WorkspaceLinkedItem | null {
  if (!item) {
    return null
  }
  return normalizeWorkspaceLinkedItem({
    ...item,
    linearIdentifier:
      item.linearIdentifier ?? (item.provider === 'linear' ? item.identifier : undefined),
    jiraIdentifier: item.jiraIdentifier ?? (item.provider === 'jira' ? item.identifier : undefined)
  })
}
