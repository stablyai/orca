import type { HostedReviewCreationBlockedReason } from '../../../../shared/hosted-review'
import { translate } from '@/i18n/i18n'
import {
  autoRetrySchedule,
  capitalizeReviewLabel,
  isHardRefreshError,
  type ChecksPanelRecoveryAction,
  type ChecksPanelReviewState,
  type ChecksPanelReviewStateInput
} from './checks-panel-review-state-model'
import { concurrentLookupDetail } from './checks-panel-review-copy'

type KeyedCopy = { key: string; fallback: string }

const SAFETY_COPY: Record<
  | 'detached_head'
  | 'dirty'
  | 'default_branch'
  | 'fork_head_unsupported'
  | 'base_not_on_remote'
  | 'unsupported_provider',
  { title: KeyedCopy; body: KeyedCopy }
> = {
  detached_head: {
    title: {
      key: 'auto.components.right.sidebar.checks.panel.review.detached.title',
      fallback: 'No current branch'
    },
    body: {
      key: 'auto.components.right.sidebar.checks.panel.review.detached.body',
      fallback: 'Check out a branch before creating a {{reviewLabel}}.'
    }
  },
  dirty: {
    title: {
      key: 'auto.components.right.sidebar.checks.panel.review.dirty.title',
      fallback: 'Commit changes first'
    },
    body: {
      key: 'auto.components.right.sidebar.checks.panel.review.dirty.body',
      fallback: 'Commit or stash your changes before creating a {{reviewLabel}}.'
    }
  },
  default_branch: {
    title: {
      key: 'auto.components.right.sidebar.checks.panel.review.default_branch.title',
      fallback: 'On the default branch'
    },
    body: {
      key: 'auto.components.right.sidebar.checks.panel.review.default_branch.body',
      fallback: 'Switch to a feature branch before creating a {{reviewLabel}}.'
    }
  },
  fork_head_unsupported: {
    title: {
      key: 'auto.components.right.sidebar.checks.panel.review.fork.title',
      fallback: 'Fork head unsupported'
    },
    body: {
      key: 'auto.components.right.sidebar.checks.panel.review.fork.body',
      fallback: 'Orca cannot create a {{reviewLabel}} from this fork head here.'
    }
  },
  base_not_on_remote: {
    title: {
      key: 'auto.components.right.sidebar.checks.panel.review.base_missing.title',
      fallback: 'Base branch not on remote'
    },
    body: {
      key: 'auto.components.right.sidebar.checks.panel.review.base_missing.body',
      fallback:
        "This branch's base is not on the remote yet, so a {{reviewLabel}} cannot target it."
    }
  },
  unsupported_provider: {
    title: {
      key: 'auto.components.right.sidebar.checks.panel.review.unsupported.title',
      fallback: '{{reviewLabelCap}} not supported here'
    },
    body: {
      key: 'auto.components.right.sidebar.checks.panel.review.unsupported.body',
      fallback: 'This repository provider does not support creating a {{reviewLabel}} from Orca.'
    }
  }
}

export function safetyBlockerState(
  input: ChecksPanelReviewStateInput,
  reason: NonNullable<HostedReviewCreationBlockedReason>
): ChecksPanelReviewState {
  const { reviewLabel } = input
  if (reason === 'existing_review') {
    // Same family as positive evidence — offer trusted Open Review, never Create.
    return {
      renderReview: false,
      title: translate(
        'auto.components.right.sidebar.checks.panel.review.existing.title',
        '{{reviewLabelCap}} already exists',
        { reviewLabelCap: capitalizeReviewLabel(reviewLabel) }
      ),
      description: translate(
        'auto.components.right.sidebar.checks.panel.review.existing.body',
        'Orca found an existing {{reviewLabel}} for this branch.',
        { reviewLabel }
      ),
      composerMode: 'hidden',
      workflowAction: null,
      recovery: input.openReviewUrl ? ['open_review'] : [],
      openReviewUrl: input.openReviewUrl
    }
  }
  const copy = SAFETY_COPY[reason as keyof typeof SAFETY_COPY] ?? SAFETY_COPY.unsupported_provider
  const vars = { reviewLabel, reviewLabelCap: capitalizeReviewLabel(reviewLabel) }
  return {
    renderReview: false,
    title: translate(copy.title.key, copy.title.fallback, vars),
    description: translate(copy.body.key, copy.body.fallback, vars),
    composerMode: 'hidden',
    workflowAction: null,
    recovery: []
  }
}

const BRANCH_BLOCKER_COPY: Record<
  'no_upstream' | 'needs_sync' | 'auth_required',
  { title: KeyedCopy; body: KeyedCopy; workflow: ChecksPanelReviewState['workflowAction'] }
> = {
  no_upstream: {
    title: {
      key: 'auto.components.right.sidebar.checks.panel.review.no_upstream.title',
      fallback: 'No upstream configured'
    },
    body: {
      key: 'auto.components.right.sidebar.checks.panel.review.no_upstream.body',
      fallback: 'Publish this branch to set its upstream before creating a {{reviewLabel}}.'
    },
    workflow: 'publish_branch'
  },
  needs_sync: {
    title: {
      key: 'auto.components.right.sidebar.checks.panel.review.needs_sync.title',
      fallback: 'Branch needs to sync'
    },
    body: {
      key: 'auto.components.right.sidebar.checks.panel.review.needs_sync.body',
      fallback: 'Sync this branch with its upstream before creating a {{reviewLabel}}.'
    },
    workflow: 'sync_branch'
  },
  auth_required: {
    title: {
      key: 'auto.components.right.sidebar.checks.panel.review.auth_required.title',
      fallback: 'Connect {{provider}}'
    },
    body: {
      key: 'auto.components.right.sidebar.checks.panel.review.auth_required.body',
      fallback:
        '{{provider}} must be connected in this environment before Orca can create a {{reviewLabel}}.'
    },
    workflow: null
  }
}

export function branchBlockerState(
  input: ChecksPanelReviewStateInput,
  reason: NonNullable<HostedReviewCreationBlockedReason>
): ChecksPanelReviewState {
  const { reviewLabel, providerName } = input
  const detail = concurrentLookupDetail(input)
  const schedule = detail ? autoRetrySchedule(input) : {}
  // Positive-unresolved evidence with a trusted URL must still expose Open Review
  // beneath the blocker (Create/Push & Create stay suppressed). Retry is offered
  // whenever a concurrent lookup failure produced a detail sentence.
  const canOpenReview = input.reviewLookup === 'positive_unresolved' && Boolean(input.openReviewUrl)
  const lookupRecovery: ChecksPanelRecoveryAction[] = [
    ...(canOpenReview ? (['open_review'] as ChecksPanelRecoveryAction[]) : []),
    ...(detail ? (['retry'] as ChecksPanelRecoveryAction[]) : [])
  ]
  const openReviewUrl = canOpenReview ? input.openReviewUrl : undefined
  const vars = { reviewLabel, provider: providerName }

  if (reason === 'needs_push') {
    // Push & Create unless review evidence or a hard error blocks create.
    const blocked =
      input.reviewLookup === 'positive_unresolved' ||
      isHardRefreshError(input.refresh) ||
      !input.confirmedReadiness
    return {
      renderReview: false,
      title: translate(
        'auto.components.right.sidebar.checks.panel.review.needs_push.title',
        'Branch has unpushed commits'
      ),
      description: translate(
        'auto.components.right.sidebar.checks.panel.review.needs_push.body',
        'Push the latest commits before creating a {{reviewLabel}}.',
        { reviewLabel }
      ),
      detail,
      composerMode: blocked ? 'hidden' : 'needs_push_open',
      workflowAction: blocked ? null : 'push_and_create',
      recovery: lookupRecovery,
      openReviewUrl,
      ...schedule
    }
  }

  const copy = BRANCH_BLOCKER_COPY[reason as keyof typeof BRANCH_BLOCKER_COPY]
  return {
    renderReview: false,
    title: translate(copy.title.key, copy.title.fallback, vars),
    description: translate(copy.body.key, copy.body.fallback, vars),
    detail,
    composerMode: 'hidden',
    workflowAction: copy.workflow,
    recovery: lookupRecovery,
    openReviewUrl,
    ...schedule
  }
}
