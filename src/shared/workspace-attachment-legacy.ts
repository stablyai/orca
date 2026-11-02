import type { WorktreeMeta } from './worktree/meta-types'
import type { WorkspaceAttachment } from './worktree/types'
import { normalizeWorkspaceAttachments } from './workspace-attachment-normalization'

export const WORKSPACE_ATTACHMENT_NUMBER_SLOTS = [
  ['linkedIssue', 'github', 'issue'],
  ['linkedPR', 'github', 'pr'],
  ['linkedGitLabMR', 'gitlab', 'mr'],
  ['linkedGitLabIssue', 'gitlab', 'issue'],
  ['linkedBitbucketPR', 'bitbucket', 'pr'],
  ['linkedAzureDevOpsPR', 'azure-devops', 'pr'],
  ['linkedGiteaPR', 'gitea', 'pr']
] as const

export const WORKSPACE_ATTACHMENT_LEGACY_FIELDS = [
  ...WORKSPACE_ATTACHMENT_NUMBER_SLOTS.map(([slot]) => [slot] as const),
  ['linkedLinearIssue', 'linkedLinearIssueWorkspaceId', 'linkedLinearIssueOrganizationUrlKey'],
  ['linkedWorkItem', 'linkedTaskSourceContext']
] as const

export type WorkspaceAttachmentMetadata = Partial<
  Pick<
    WorktreeMeta,
    (typeof WORKSPACE_ATTACHMENT_LEGACY_FIELDS)[number][number] | 'linkedItems' | 'pushTarget'
  >
>

export function getLegacyWorkspaceReviewSelectionUpdates(
  updates: Partial<WorktreeMeta>
): Partial<WorktreeMeta> {
  const reviews = WORKSPACE_ATTACHMENT_NUMBER_SLOTS.filter(([, , type]) => type !== 'issue')
  const selected = reviews.find(([slot]) => typeof updates[slot] === 'number' && updates[slot] > 0)
  if (updates.linkedItems !== undefined || !selected) {
    return updates
  }
  return {
    ...updates,
    ...Object.fromEntries(
      reviews.filter(([slot]) => slot !== selected[0]).map(([slot]) => [slot, null])
    )
  }
}

export function pickWorkspaceAttachmentFields(
  meta: WorkspaceAttachmentMetadata | undefined,
  fields: readonly (keyof WorkspaceAttachmentMetadata)[]
): WorkspaceAttachmentMetadata {
  return Object.fromEntries(fields.map((field) => [field, meta?.[field]]))
}

export function legacyWorkspaceAttachments(
  meta: WorkspaceAttachmentMetadata
): WorkspaceAttachment[] {
  const items: unknown[] = WORKSPACE_ATTACHMENT_NUMBER_SLOTS.map(([slot, provider, type]) => ({
    provider,
    type,
    number: meta[slot]
  }))
  // Rich identities carry the task source before their compatibility slots are folded in.
  if (meta.linkedWorkItem) {
    items.unshift({
      ...meta.linkedWorkItem,
      taskSourceContext: meta.linkedTaskSourceContext,
      ...(meta.linkedWorkItem.provider === 'linear'
        ? {
            linearWorkspaceId: meta.linkedLinearIssueWorkspaceId,
            linearOrganizationUrlKey: meta.linkedLinearIssueOrganizationUrlKey
          }
        : {})
    })
  }
  if (meta.linkedLinearIssue?.trim()) {
    items.push({
      provider: 'linear',
      type: 'issue',
      number: 0,
      identifier: meta.linkedLinearIssue ?? undefined,
      linearIdentifier: meta.linkedLinearIssue ?? undefined,
      linearWorkspaceId: meta.linkedLinearIssueWorkspaceId ?? undefined,
      linearOrganizationUrlKey: meta.linkedLinearIssueOrganizationUrlKey ?? undefined
    })
  }
  return normalizeWorkspaceAttachments(items)
}
