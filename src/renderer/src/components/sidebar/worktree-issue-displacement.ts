import { translate } from '@/i18n/i18n'
import type { IssueLinkProvider } from '../../../../shared/issue-link-input'
import {
  isIssueFieldDirty,
  type WorktreeMetaDraft,
  type WorktreeMetaSnapshot
} from './worktree-meta-updates'

function formatLinkLabel(provider: IssueLinkProvider, value: string): string {
  return provider === 'linear'
    ? translate(
        'auto.components.sidebar.worktreeIssueDisplacement.3f61c0a8d2',
        'Linear {{value}}',
        { value }
      )
    : translate(
        'auto.components.sidebar.worktreeIssueDisplacement.9c4b7e1f60',
        'GitHub #{{value}}',
        { value }
      )
}

/** Names the persisted links a save would drop. A workspace tracks one issue, so
 *  a changed field displaces the other provider's slot and clearing drops both.
 *  Only a dirty field displaces anything — the dialog opens focused on Comment,
 *  and an untouched row must leave every link alone. */
export function getDisplacedLinkLabels(args: {
  draft: WorktreeMetaDraft
  snapshot: WorktreeMetaSnapshot
  isFolderWorkspace: boolean
  linkedIssue: number | null
  linkedLinearIssue: string | null
}): string[] | null {
  const { draft, snapshot, isFolderWorkspace, linkedIssue, linkedLinearIssue } = args
  if (isFolderWorkspace || !isIssueFieldDirty(draft, snapshot)) {
    return null
  }

  const keeping = draft.issueInput.trim() === '' ? null : draft.issueProvider
  const displaced: string[] = []
  if (keeping !== 'linear' && linkedLinearIssue) {
    displaced.push(formatLinkLabel('linear', linkedLinearIssue))
  }
  if (keeping !== 'github' && typeof linkedIssue === 'number') {
    displaced.push(formatLinkLabel('github', String(linkedIssue)))
  }
  return displaced.length > 0 ? displaced : null
}
