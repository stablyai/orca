import { rebaseWorkspaceAttachmentOrigins } from './workspace-attachment-origins'
import type { WorkspaceAttachment } from './worktree/types'
import {
  getWorkspaceAttachmentKey,
  matchesWorkspaceAttachmentIdentity,
  normalizeWorkspaceAttachments
} from './workspace-attachment-normalization'

/** Mutation-only snapshot; never persisted with workspace metadata. */
export type WorkspaceAttachmentMutation = {
  linkedItemsBase?: WorkspaceAttachment[]
  linkedItemsSelectionChanged?: boolean
}

export function mergeWorkspaceAttachmentMutation(
  base: readonly WorkspaceAttachment[],
  current: readonly WorkspaceAttachment[],
  requested: readonly WorkspaceAttachment[]
): WorkspaceAttachment[] {
  const currentKeys = new Set(current.map(getWorkspaceAttachmentKey))
  const baseKey = (item: WorkspaceAttachment): string => {
    const key = getWorkspaceAttachmentKey(item)
    if (currentKeys.has(key)) {
      return key
    }
    const matches = current.filter((candidate) =>
      matchesWorkspaceAttachmentIdentity(candidate, item)
    )
    const requestedVersions = requested.filter((candidate) =>
      matchesWorkspaceAttachmentIdentity(candidate, item)
    )
    if (
      matches.length === 1 &&
      (requestedVersions.length === 0 ||
        requestedVersions.some(
          (candidate) =>
            matchesWorkspaceAttachmentIdentity(matches[0], candidate) ||
            matchesWorkspaceAttachmentIdentity(candidate, matches[0])
        ))
    ) {
      return getWorkspaceAttachmentKey(matches[0])
    }
    return key
  }
  const mutationKey = (item: WorkspaceAttachment): string => {
    const key = getWorkspaceAttachmentKey(item)
    if (currentKeys.has(key)) {
      return key
    }
    const previous = base.filter((candidate) => matchesWorkspaceAttachmentIdentity(item, candidate))
    const original = previous.length === 1 ? previous[0] : undefined
    return original &&
      requested.filter((candidate) => matchesWorkspaceAttachmentIdentity(candidate, original))
        .length === 1
      ? baseKey(original)
      : key
  }
  const baseByKey = new Map(base.map((item) => [baseKey(item), item]))
  const requestedByKey = new Map(requested.map((item) => [mutationKey(item), item]))
  const retained = current
    .filter((item) => {
      const key = getWorkspaceAttachmentKey(item)
      return !baseByKey.has(key) || requestedByKey.has(key)
    })
    .map((item) => {
      const key = getWorkspaceAttachmentKey(item)
      const changed = requestedByKey.get(key)
      if (!changed || JSON.stringify(baseByKey.get(key)) === JSON.stringify(changed)) {
        return item
      }
      const previous = baseByKey.get(key)
      const fields = [
        'title',
        'url',
        'repoId',
        'identifier',
        'linearIdentifier',
        'jiraIdentifier',
        'linearWorkspaceId',
        'linearOrganizationUrlKey',
        'taskSourceContext'
      ] as const
      const patch = Object.fromEntries(
        fields
          .filter((field) => JSON.stringify(previous?.[field]) !== JSON.stringify(changed[field]))
          .map((field) => [field, changed[field]])
      )
      return {
        ...item,
        ...patch,
        ...(changed.origins !== undefined
          ? {
              origins: rebaseWorkspaceAttachmentOrigins(
                item.origins,
                previous?.origins,
                changed.origins
              )
            }
          : {})
      }
    })
  const additions = requested.filter((item) => {
    const key = mutationKey(item)
    return !baseByKey.has(key) && !currentKeys.has(key)
  })
  return normalizeWorkspaceAttachments([...retained, ...additions])
}
