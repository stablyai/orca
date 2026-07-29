import type { GitHubPRRefreshSkippedReason } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { getGitHubUnavailableEmptyStateCopy } from './github-refresh-error-copy'
import {
  autoRetrySchedule,
  capitalizeReviewLabel,
  isHardRefreshError,
  isRateLimitRefresh,
  type ChecksPanelRecoveryAction,
  type ChecksPanelReviewState,
  type ChecksPanelReviewStateInput
} from './checks-panel-review-state-model'

type KeyedCopy = { key: string; fallback: string }

/**
 * Muted sentence appended beneath a blocker or accepted-no-review body when a
 * concurrent lookup failure or positive-unresolved evidence is also current.
 */
export function concurrentLookupDetail(input: ChecksPanelReviewStateInput): string | undefined {
  const { reviewLabel, providerName, refresh } = input
  if (input.reviewLookup === 'positive_unresolved') {
    return translate(
      'auto.components.right.sidebar.checks.panel.review.detail.positive',
      'Orca also has saved {{reviewLabel}} information that it could not verify.',
      { reviewLabel }
    )
  }
  if (isRateLimitRefresh(refresh)) {
    return translate(
      'auto.components.right.sidebar.checks.panel.review.detail.rate_limited',
      'Orca also could not check {{reviewLabel}} status because {{provider}} is temporarily limiting requests.',
      { reviewLabel, provider: providerName }
    )
  }
  if (refresh?.errorType === 'network') {
    return translate(
      'auto.components.right.sidebar.checks.panel.review.detail.network',
      'Orca also could not check {{reviewLabel}} status because this environment could not reach {{provider}}.',
      { reviewLabel, provider: providerName }
    )
  }
  if (refresh?.status === 'error' || isHardRefreshError(refresh)) {
    return translate(
      'auto.components.right.sidebar.checks.panel.review.detail.untyped',
      'Orca also could not confirm whether this branch already has a {{reviewLabel}}.',
      { reviewLabel }
    )
  }
  return undefined
}

export function transientRefreshState(
  input: ChecksPanelReviewStateInput,
  composerMode: ChecksPanelReviewState['composerMode'],
  workflowAction: ChecksPanelReviewState['workflowAction']
): ChecksPanelReviewState {
  const { reviewLabel, providerName, refresh } = input
  const schedule = autoRetrySchedule(input)
  const base = {
    renderReview: false as const,
    composerMode,
    workflowAction,
    recovery: ['retry'] as ChecksPanelRecoveryAction[],
    ...schedule
  }
  // Why: preserve the upstream GitHub-attributed 5xx copy in the unified state model.
  const githubUnavailableCopy =
    refresh?.errorType === 'server_error'
      ? getGitHubUnavailableEmptyStateCopy(refresh.errorType)
      : null
  if (githubUnavailableCopy) {
    return { ...base, ...githubUnavailableCopy }
  }
  if (isRateLimitRefresh(refresh)) {
    return {
      ...base,
      title: translate(
        'auto.components.right.sidebar.checks.panel.review.paused.title',
        '{{provider}} refresh paused',
        { provider: providerName }
      ),
      description: translate(
        'auto.components.right.sidebar.checks.panel.review.paused.body',
        '{{provider}} is temporarily limiting requests. This can happen even when the displayed API quota is not exhausted.',
        { provider: providerName }
      )
    }
  }
  if (refresh?.errorType === 'network') {
    return {
      ...base,
      title: translate(
        'auto.components.right.sidebar.checks.panel.review.network.title',
        'Could not reach {{provider}}',
        { provider: providerName }
      ),
      description: translate(
        'auto.components.right.sidebar.checks.panel.review.network.body',
        'This environment could not reach {{provider}}. Check its connection, then retry.',
        { provider: providerName }
      )
    }
  }
  if (refresh?.errorType === 'unknown') {
    return {
      ...base,
      title: translate(
        'auto.components.right.sidebar.checks.panel.review.unknown_error.title',
        'Could not check {{reviewLabel}} status',
        { reviewLabel }
      ),
      description: translate(
        'auto.components.right.sidebar.checks.panel.review.unknown_error.body',
        'The lookup failed, so Orca could not confirm whether this branch already has a {{reviewLabel}}.',
        { reviewLabel }
      )
    }
  }
  return {
    ...base,
    title: translate(
      'auto.components.right.sidebar.checks.panel.review.untyped.title',
      '{{reviewLabelCap}} status unavailable',
      { reviewLabelCap: capitalizeReviewLabel(reviewLabel) }
    ),
    description: translate(
      'auto.components.right.sidebar.checks.panel.review.untyped.body',
      'Orca could not confirm whether this branch already has a {{reviewLabel}}. Retry to check again.',
      { reviewLabel }
    )
  }
}

const HARD_ERROR_COPY: Record<
  'auth' | 'permission' | 'repo_unavailable' | 'gh_unavailable',
  {
    title: KeyedCopy
    body: KeyedCopy
  }
> = {
  auth: {
    title: {
      key: 'auto.components.right.sidebar.checks.panel.review.auth.title',
      fallback: '{{provider}} authentication failed'
    },
    body: {
      key: 'auto.components.right.sidebar.checks.panel.review.auth.body',
      fallback:
        '{{provider}} could not authenticate the credentials available in this environment. Check the {{provider}} login or environment token, then retry.'
    }
  },
  permission: {
    title: {
      key: 'auto.components.right.sidebar.checks.panel.review.permission.title',
      fallback: '{{provider}} access denied'
    },
    body: {
      key: 'auto.components.right.sidebar.checks.panel.review.permission.body',
      fallback:
        "The current {{provider}} credentials cannot read this repository's {{reviewLabel}}s. Check the account, token scopes, and repository access, then retry."
    }
  },
  repo_unavailable: {
    title: {
      key: 'auto.components.right.sidebar.checks.panel.review.repo.title',
      fallback: '{{provider}} repository unavailable'
    },
    body: {
      key: 'auto.components.right.sidebar.checks.panel.review.repo.body',
      fallback:
        '{{provider}} could not resolve or access the repository for the current remote and account. Check the remote and repository access, then retry.'
    }
  },
  gh_unavailable: {
    title: {
      key: 'auto.components.right.sidebar.checks.panel.review.cli.title',
      fallback: '{{provider}} CLI unavailable'
    },
    body: {
      key: 'auto.components.right.sidebar.checks.panel.review.cli.body',
      fallback:
        'Orca could not run {{provider}} CLI in this environment. Set it up here, then retry.'
    }
  }
}

export function hardRefreshErrorState(input: ChecksPanelReviewStateInput): ChecksPanelReviewState {
  const { reviewLabel, providerName, refresh } = input
  const copy =
    HARD_ERROR_COPY[(refresh?.errorType as keyof typeof HARD_ERROR_COPY) ?? 'gh_unavailable'] ??
    HARD_ERROR_COPY.gh_unavailable
  const vars = { provider: providerName, reviewLabel }
  return {
    renderReview: false,
    title: translate(copy.title.key, copy.title.fallback, vars),
    description: translate(copy.body.key, copy.body.fallback, vars),
    composerMode: 'hidden',
    workflowAction: null,
    recovery: ['retry']
  }
}

const SKIPPED_COPY: Partial<
  Record<
    GitHubPRRefreshSkippedReason,
    { title: KeyedCopy; body: KeyedCopy; recovery: ChecksPanelRecoveryAction[] }
  >
> = {
  disconnected: {
    title: {
      key: 'auto.components.right.sidebar.checks.panel.review.skipped.disconnected.title',
      fallback: 'Host disconnected'
    },
    body: {
      key: 'auto.components.right.sidebar.checks.panel.review.skipped.disconnected.body',
      fallback:
        "This repository's execution host is disconnected, so Orca cannot refresh {{reviewLabel}} status."
    },
    recovery: ['retry']
  },
  bare: {
    title: {
      key: 'auto.components.right.sidebar.checks.panel.review.skipped.bare.title',
      fallback: 'Bare repository'
    },
    body: {
      key: 'auto.components.right.sidebar.checks.panel.review.skipped.bare.body',
      fallback: 'This repository is bare, so {{reviewLabel}} status is not available here.'
    },
    recovery: []
  },
  archived: {
    title: {
      key: 'auto.components.right.sidebar.checks.panel.review.skipped.archived.title',
      fallback: 'Repository archived'
    },
    body: {
      key: 'auto.components.right.sidebar.checks.panel.review.skipped.archived.body',
      fallback: 'This repository is archived, so Orca is not refreshing {{reviewLabel}} status.'
    },
    recovery: []
  },
  'not-git': {
    title: {
      key: 'auto.components.right.sidebar.checks.panel.review.skipped.not_git.title',
      fallback: 'Not a Git repository'
    },
    body: {
      key: 'auto.components.right.sidebar.checks.panel.review.skipped.not_git.body',
      fallback: 'Orca could not treat this folder as a Git repository for {{reviewLabel}} status.'
    },
    recovery: []
  },
  remote: {
    title: {
      key: 'auto.components.right.sidebar.checks.panel.review.skipped.remote.title',
      fallback: 'Remote-only context'
    },
    body: {
      key: 'auto.components.right.sidebar.checks.panel.review.skipped.remote.body',
      fallback:
        'Orca could not refresh {{reviewLabel}} status for this remote context. Retry after the host is available.'
    },
    recovery: ['retry']
  }
}

/** Returns the skipped-reason row, or `null` to defer to the missing/unknown row. */
export function skippedRefreshState(
  input: ChecksPanelReviewStateInput,
  skippedReason: GitHubPRRefreshSkippedReason
): ChecksPanelReviewState | null {
  const copy = SKIPPED_COPY[skippedReason]
  if (!copy) {
    // `fresh` (and any unknown skip) with no accepted result → missing/unknown.
    return null
  }
  const vars = { reviewLabel: input.reviewLabel }
  return {
    renderReview: false,
    title: translate(copy.title.key, copy.title.fallback, vars),
    description: translate(copy.body.key, copy.body.fallback, vars),
    composerMode: 'hidden',
    workflowAction: null,
    recovery: copy.recovery
  }
}
