import React from 'react'
import { CircleDot } from 'lucide-react'
import { LinearIcon } from '@/components/icons/LinearIcon'
import { JiraIcon } from '@/components/icons/JiraIcon'
import { getWorkspaceAttachmentKey } from '../../../../../../shared/workspace-attachments/workspace-attachment-normalization'
import { getProviderChecksOutcome } from '../../../../../../shared/source-control/checks/provider-check-summary'
import type { WorkspaceAttachment } from '../../../../../../shared/worktree/types'
import { ReviewIcon } from './worktree-review-presentation'
import { workspaceAttachmentLabel } from '../metadata/worktree-attachment-editing'
import {
  workspaceReferenceReview,
  type WorkspaceReferenceDetailsMap
} from './workspace-reference-details'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import '../activity/worktree-card-empty-inputs'
import { checksLabel } from './workspace-review-check-label'
const EMPTY_DETAILS: WorkspaceReferenceDetailsMap = {}

function singleReferenceLabel(item: WorkspaceAttachment, t: Translate = translate): string {
  if (item.provider === 'linear') {
    return t('auto.components.sidebar.WorktreeCardMeta.b105fd3057', 'Linked Linear {{value0}}', {
      value0: item.identifier ?? item.linearIdentifier
    })
  }
  if (item.provider === 'jira') {
    return t('auto.components.sidebar.WorktreeCardMeta.linkedJira', 'Linked Jira {{value0}}', {
      value0: item.identifier ?? item.jiraIdentifier
    })
  }
  return item.type === 'issue'
    ? t('auto.components.sidebar.WorktreeCardMeta.3f2649eeb8', 'Linked issue #{{value0}}', {
        value0: item.number
      })
    : t('auto.components.sidebar.WorktreeCardMeta.3ea2702e62', 'Linked {{value0}} #{{value1}}', {
        value0: item.type === 'mr' ? 'MR' : 'PR',
        value1: item.number
      })
}

function ReferenceGlyph({
  item,
  details
}: {
  item: WorkspaceAttachment
  details: WorkspaceReferenceDetailsMap
}): React.JSX.Element {
  const review = workspaceReferenceReview(item, details[getWorkspaceAttachmentKey(item)])
  if (review) {
    return <ReviewIcon review={review} />
  }
  if (item.provider === 'linear') {
    return <LinearIcon className="text-muted-foreground" />
  }
  if (item.provider === 'jira') {
    return <JiraIcon className="text-muted-foreground" />
  }
  return <CircleDot className="text-muted-foreground" />
}

function priority(item: WorkspaceAttachment, details: WorkspaceReferenceDetailsMap): number {
  const key = getWorkspaceAttachmentKey(item)
  const detail = details[key]
  if (item.type !== 'issue') {
    const review = detail?.review
    const status = review && getProviderChecksOutcome(review.checksSummary, review.status)
    return review?.state === 'open'
      ? status === 'failure'
        ? 0
        : status === 'pending'
          ? 1
          : status === 'cancelled'
            ? 2
            : 3
      : review?.state === 'draft'
        ? 4
        : review?.state === 'merged'
          ? 5
          : review?.state === 'closed'
            ? 6
            : 7
  }
  const state = detail?.stateName?.toLowerCase() ?? ''
  if (detail?.stateType) {
    return detail.stateType === 'started'
      ? 0
      : detail.stateType === 'unstarted' || detail.stateType === 'backlog'
        ? 1
        : detail.stateType === 'completed'
          ? 2
          : detail.stateType === 'canceled'
            ? 3
            : 4
  }
  return /progress|started|doing|active/.test(state)
    ? 0
    : /todo|backlog|unstarted/.test(state)
      ? 1
      : /done|complete|resolved/.test(state)
        ? 2
        : /cancel|duplicate/.test(state)
          ? 3
          : 4
}

export function WorktreeReferenceStack({
  items,
  details = EMPTY_DETAILS
}: {
  items: readonly WorkspaceAttachment[]
  details?: WorkspaceReferenceDetailsMap
}): React.JSX.Element | null {
  const t = useTranslate()
  const ordered = [...items].sort((a, b) => priority(a, details) - priority(b, details))
  const front = ordered[0]
  if (!front) {
    return null
  }
  const summary = ordered
    .map((item) => {
      const detail = details[getWorkspaceAttachmentKey(item)]
      const review = detail?.review
      const status = review && getProviderChecksOutcome(review.checksSummary, review.status)
      return [
        workspaceAttachmentLabel(item),
        review?.state ?? detail?.stateName,
        status === 'cancelled' ? checksLabel(status, t) : status
      ]
        .filter(Boolean)
        .join(' · ')
    })
    .join(', ')
  return (
    <span
      className="workspace-reference-stack"
      data-workspace-reference-stack={front.type === 'issue' ? front.provider : 'review'}
    >
      {ordered
        .slice(1, 3)
        .toReversed()
        .map((item, index, ghosts) => (
          <span
            key={getWorkspaceAttachmentKey(item)}
            className="workspace-reference-stack-ghost"
            data-depth={ghosts.length - index}
            aria-hidden
          >
            <ReferenceGlyph item={item} details={details} />
          </span>
        ))}
      <span className="workspace-reference-stack-front" data-reference-front="" aria-hidden>
        <ReferenceGlyph item={front} details={details} />
      </span>
      {items.length > 1 ? (
        <span
          className="workspace-reference-stack-count z-3 text-3xs leading-none font-medium text-muted-foreground"
          data-reference-count=""
          data-multiple-digits={items.length > 9}
          aria-hidden
        >
          {items.length}
        </span>
      ) : null}
      <span className="sr-only">
        {items.length === 1
          ? singleReferenceLabel(front, t)
          : t('workspace.links.stackSummary', '{{count}} linked: {{references}}', {
              count: items.length,
              references: summary
            })}
      </span>
    </span>
  )
}
