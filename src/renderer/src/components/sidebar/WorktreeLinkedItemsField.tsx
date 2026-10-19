import { WorktreeLinkedItemRow } from './WorktreeLinkedItemRow'
import { translate } from '@/i18n/i18n'
import React, { useState } from 'react'
import { Link2 } from 'lucide-react'
import { Label } from '@/components/ui/label'
import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceAttachment, Worktree } from '../../../../shared/worktree/types'
import { getWorkspaceAttachmentKey } from '../../../../shared/workspace-attachment-normalization'
import {
  canUseWorkspaceReviewForChecks,
  isWorkspaceRepositoryAttachment,
  type AttachmentInputKind
} from './worktree-attachment-editing'
import { WorkspaceAttachmentComposer } from './WorkspaceAttachmentComposer'
import {
  appendWorkspaceAttachment,
  isWorkspaceAttachmentLinked
} from './workspace-attachment-source-result'

type Props = {
  items: readonly WorkspaceAttachment[]
  onItemsChange: (items: WorkspaceAttachment[]) => void
  onSave: () => void
  repo?: Repo
  workspace?: Worktree
  isFolderWorkspace?: boolean
  inputRef: React.RefObject<HTMLInputElement | null>
  initialKind: AttachmentInputKind
  initialInput?: string
  disabled: boolean
}

export function WorktreeLinkedItemsField({
  items,
  onItemsChange,
  onSave,
  repo,
  workspace,
  isFolderWorkspace = false,
  inputRef,
  initialKind,
  initialInput = '',
  disabled
}: Props): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const getScopeError = (item: WorkspaceAttachment): string | null => {
    if (
      !isFolderWorkspace &&
      item.type !== 'issue' &&
      !item.url &&
      !canUseWorkspaceReviewForChecks(item, repo)
    ) {
      return translate(
        'workspace.links.reviewUrlRequired',
        'Paste the review URL to verify its repository and provider.'
      )
    }
    if (
      !item.url ||
      (item.type === 'issue' && item.provider !== 'github' && item.provider !== 'gitlab') ||
      isFolderWorkspace ||
      isWorkspaceRepositoryAttachment(item, repo)
    ) {
      return null
    }
    if (!repo?.gitRemoteIdentity) {
      return translate(
        'workspace.links.repositoryLoading',
        'Repository identity is still loading. Try again once it is available.'
      )
    }
    return item.type === 'issue'
      ? translate(
          'workspace.links.foreignIssue',
          'This issue belongs to another repository. Add issues from this workspace’s repository.'
        )
      : translate(
          'workspace.links.foreignReview',
          'This review belongs to another repository. Add reviews from this workspace’s repository.'
        )
  }
  const add = (item: WorkspaceAttachment): boolean => {
    if (disabled) {
      return false
    }
    const scopeError = getScopeError(item)
    if (scopeError) {
      setError(scopeError)
      return false
    }
    if (isWorkspaceAttachmentLinked(items, item)) {
      setError(translate('workspace.links.duplicate', 'This link is already attached.'))
      return false
    }
    onItemsChange(appendWorkspaceAttachment(items, item))
    setError(null)
    return true
  }
  const remove = (key: string): void => {
    const next = items.filter((item) => getWorkspaceAttachmentKey(item) !== key)
    onItemsChange(next)
  }
  const groups = [
    {
      label: translate('workspace.links.reviews', 'Reviews'),
      items: items.filter((item) => item.type !== 'issue')
    },
    {
      label: translate('workspace.links.tasks', 'Issues & tasks'),
      items: items.filter((item) => item.type === 'issue')
    }
  ].filter((group) => group.items.length > 0)

  return (
    <div className="space-y-3" data-workspace-linked-items="">
      <div className="flex items-center justify-between gap-2">
        <Label>{translate('workspace.links.title', 'Linked work')}</Label>
        <span className="text-xs text-muted-foreground">
          {translate('workspace.links.count', '{{count}} linked', { count: items.length })}
        </span>
      </div>
      <WorkspaceAttachmentComposer
        items={items}
        repo={repo}
        workspace={workspace}
        disabled={disabled}
        initialKind={initialKind}
        initialInput={initialInput}
        inputRef={inputRef}
        onAdd={add}
        onSave={onSave}
        onQueryChange={() => setError(null)}
        getScopeError={getScopeError}
        error={error}
      />
      {items.length === 0 ? (
        <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <Link2 className="size-4 shrink-0" />
          <span>
            {translate(
              'workspace.links.empty',
              'Keep every review and task for this workspace together.'
            )}
          </span>
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => (
            <div key={group.label} className="space-y-1">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {group.label} · {group.items.length}
              </p>
              <div className="divide-y divide-border">
                {group.items.map((item) => {
                  const key = getWorkspaceAttachmentKey(item)
                  return (
                    <WorktreeLinkedItemRow
                      key={key}
                      item={item}
                      workspace={workspace}
                      disabled={disabled}
                      onRemove={() => remove(key)}
                    />
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
