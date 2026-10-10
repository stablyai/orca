import { getWorkspaceReferenceIdentity } from './workspace-reference-identity'
import {
  WORKSPACE_ATTACHMENT_NUMBER_SLOTS,
  WORKSPACE_ATTACHMENT_LEGACY_FIELDS,
  pickWorkspaceAttachmentFields,
  legacyWorkspaceAttachments,
  type WorkspaceAttachmentMetadata
} from './workspace-attachment-legacy'
import { removeSelectedWorkspaceAttachments } from './workspace-attachment-removal'
import type { WorktreeMeta } from './worktree/meta-types'
import type { WorkspaceAttachment } from './worktree/types'
import {
  mergeWorkspaceAttachmentMutation,
  type WorkspaceAttachmentMutation
} from './workspace-attachment-mutation'
import {
  normalizeWorkspaceAttachments,
  toWorkspaceLinkedItem,
  matchesWorkspaceAttachmentIdentity
} from './workspace-attachment-normalization'

export function matchesLegacyWorkspaceAttachment(
  item: WorkspaceAttachment,
  legacy: WorkspaceAttachment
): boolean {
  return (
    getWorkspaceReferenceIdentity(item) === getWorkspaceReferenceIdentity(legacy) ||
    matchesWorkspaceAttachmentIdentity(item, legacy)
  )
}

export function getWorkspaceAttachments(
  meta: WorkspaceAttachmentMetadata | null | undefined
): WorkspaceAttachment[] {
  if (!meta) {
    return []
  }
  const items = normalizeWorkspaceAttachments(meta.linkedItems)
  for (const legacy of legacyWorkspaceAttachments(meta)) {
    if (!items.some((item) => matchesLegacyWorkspaceAttachment(item, legacy))) {
      items.push(legacy)
    }
  }
  return items
}

function synchronizeSelection(
  meta: WorkspaceAttachmentMetadata,
  items: WorkspaceAttachment[],
  updates: WorkspaceAttachmentMetadata
): WorkspaceAttachmentMetadata {
  const result: WorkspaceAttachmentMetadata = { linkedItems: items }
  const reviews = items.filter((item) => item.type !== 'issue')
  const selectionCleared = WORKSPACE_ATTACHMENT_NUMBER_SLOTS.filter(
    ([, , type]) => type !== 'issue'
  ).every(([slot]) => updates[slot] === null)
  const selectedReview = selectionCleared
    ? undefined
    : (reviews.find((item) =>
        WORKSPACE_ATTACHMENT_NUMBER_SLOTS.some(
          ([slot, provider, type]) =>
            type !== 'issue' &&
            item.provider === provider &&
            item.type === type &&
            updates[slot] === item.number
        )
      ) ??
      reviews.find((item) =>
        WORKSPACE_ATTACHMENT_NUMBER_SLOTS.some(
          ([slot, provider, type]) =>
            type !== 'issue' &&
            item.provider === provider &&
            item.type === type &&
            meta[slot] === item.number
        )
      ) ??
      reviews[0])
  for (const [slot, provider, type] of WORKSPACE_ATTACHMENT_NUMBER_SLOTS) {
    const selected =
      type !== 'issue'
        ? selectedReview
        : (items.find(
            (item) => item.provider === provider && item.type === type && item.number === meta[slot]
          ) ?? items.find((item) => item.provider === provider && item.type === type))
    result[slot] =
      selected?.provider === provider && selected.type === type ? selected.number : null
  }
  const linear =
    items.find(
      (item) =>
        item.provider === 'linear' &&
        (item.identifier ?? item.linearIdentifier) === meta.linkedLinearIssue
    ) ?? items.find((item) => item.provider === 'linear')
  result.linkedLinearIssue = linear?.identifier ?? linear?.linearIdentifier ?? null
  result.linkedLinearIssueWorkspaceId = linear?.linearWorkspaceId ?? null
  result.linkedLinearIssueOrganizationUrlKey = linear?.linearOrganizationUrlKey ?? null
  const previous = legacyWorkspaceAttachments({
    linkedWorkItem: meta.linkedWorkItem,
    linkedTaskSourceContext: meta.linkedTaskSourceContext
  })[0]
  const rich =
    (previous && items.find((item) => matchesWorkspaceAttachmentIdentity(item, previous))) ??
    items.find((item) => item.type === 'issue' && toWorkspaceLinkedItem(item))
  result.linkedWorkItem = toWorkspaceLinkedItem(rich)
  result.linkedTaskSourceContext = rich?.taskSourceContext ?? null
  return result
}

export function normalizeWorkspaceAttachmentUpdate(
  existing: WorkspaceAttachmentMetadata | undefined,
  mutation: Partial<WorktreeMeta> & WorkspaceAttachmentMutation
): Partial<WorktreeMeta> {
  const { linkedItemsBase, linkedItemsSelectionChanged, ...updates } = mutation
  const reviewSlots = WORKSPACE_ATTACHMENT_NUMBER_SLOTS.filter(([, , type]) => type !== 'issue')
  const preserveSelection =
    linkedItemsBase !== undefined &&
    updates.linkedItems !== undefined &&
    linkedItemsSelectionChanged === false
  const requested = preserveSelection
    ? Object.fromEntries(
        Object.entries(updates).filter(([key]) => !reviewSlots.some(([slot]) => slot === key))
      )
    : updates
  if (
    !Object.entries(requested).some(
      ([key, value]) => key.startsWith('linked') && value !== undefined
    )
  ) {
    return 'linkedItemsBase' in mutation || 'linkedItemsSelectionChanged' in mutation
      ? requested
      : mutation
  }
  const merged = {
    ...existing,
    ...Object.fromEntries(Object.entries(requested).filter(([, value]) => value !== undefined))
  }
  if (updates.linkedItems !== undefined) {
    const items =
      linkedItemsBase === undefined
        ? normalizeWorkspaceAttachments(updates.linkedItems)
        : mergeWorkspaceAttachmentMutation(
            linkedItemsBase,
            getWorkspaceAttachments(existing),
            updates.linkedItems
          )
    const normalized = {
      ...requested,
      ...synchronizeSelection(merged, items, requested)
    }
    if (
      preserveSelection &&
      Object.hasOwn(updates, 'pushTarget') &&
      reviewSlots.some(([slot]) => (normalized[slot] ?? null) !== (updates[slot] ?? null))
    ) {
      normalized.pushTarget = existing?.pushTarget
    }
    return normalized
  }
  let items = getWorkspaceAttachments(existing)
  const selectedTask = legacyWorkspaceAttachments({
    linkedWorkItem: existing?.linkedWorkItem,
    linkedTaskSourceContext: existing?.linkedTaskSourceContext
  })[0]
  for (const fields of WORKSPACE_ATTACHMENT_LEGACY_FIELDS) {
    if (updates[fields[0]] === null) {
      items = removeSelectedWorkspaceAttachments(
        items,
        legacyWorkspaceAttachments(pickWorkspaceAttachmentFields(existing, fields)),
        selectedTask
      )
    }
  }
  // Do not resurrect a removed rich item through its other compatibility slot.
  const additions = legacyWorkspaceAttachments({
    ...updates,
    ...(updates.linkedWorkItem !== undefined
      ? { linkedTaskSourceContext: merged.linkedTaskSourceContext }
      : {}),
    ...(updates.linkedLinearIssue !== undefined
      ? {
          linkedLinearIssueWorkspaceId: merged.linkedLinearIssueWorkspaceId,
          linkedLinearIssueOrganizationUrlKey: merged.linkedLinearIssueOrganizationUrlKey
        }
      : {})
  })
  for (const item of additions) {
    const index = items.findIndex((candidate) =>
      matchesWorkspaceAttachmentIdentity(candidate, item)
    )
    if (index === -1) {
      items.push(item)
    } else {
      items[index] = { ...items[index], ...item }
    }
  }
  const result: WorkspaceAttachmentMetadata = {
    ...updates,
    linkedItems: normalizeWorkspaceAttachments(items)
  }
  const selectedReviewSlot = WORKSPACE_ATTACHMENT_NUMBER_SLOTS.find(
    ([slot, , type]) => type !== 'issue' && typeof updates[slot] === 'number'
  )?.[0]
  if (selectedReviewSlot) {
    for (const [slot, , type] of WORKSPACE_ATTACHMENT_NUMBER_SLOTS) {
      if (type !== 'issue' && slot !== selectedReviewSlot) {
        result[slot] = null
      }
    }
  }
  for (const fields of WORKSPACE_ATTACHMENT_LEGACY_FIELDS) {
    if (updates[fields[0]] !== undefined) {
      continue
    }
    const previous = legacyWorkspaceAttachments(pickWorkspaceAttachmentFields(existing, fields))[0]
    if (previous && !items.some((item) => matchesWorkspaceAttachmentIdentity(item, previous))) {
      Object.assign(result, Object.fromEntries(fields.map((field) => [field, null])))
    }
  }
  return result
}
