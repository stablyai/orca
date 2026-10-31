import { translate } from '@/i18n/i18n'
import {
  classifySubmodulePushFailure,
  formatSubmodulePushFailureSentence
} from '../../../shared/git-remote-error'
import {
  LINT_PUSH_FAILURE_SUMMARY,
  PRE_PUSH_FAILURE_SUMMARY
} from '../../../shared/source-control-push-failure'

export type PushLikeOperation = 'publish' | 'sync' | 'forcePush' | 'push'
export type RemoteOperation = PushLikeOperation | 'fetch' | 'fastForward' | 'rebase' | 'pull'
// Sync shares pull wording for merge refusals; fast-forward only differs for overwrite refusals.
export type PullLikeOperation = 'rebase' | 'sync' | 'fastForward' | 'pull'

export function translateSubmodulePushFailureDetail(message: string): string | null {
  const failure = classifySubmodulePushFailure(message)
  if (!failure) {
    return null
  }
  // Case-variant normalized text is not Orca's sentence; show it verbatim.
  if (
    failure.detail !==
    formatSubmodulePushFailureSentence(failure.submoduleName, failure.remoteChanged)
  ) {
    return failure.detail
  }
  const name = failure.submoduleName
  if (failure.remoteChanged) {
    return name
      ? translate(
          'sourceControl.remoteError.submodule.namedRemoteChanged',
          "Submodule '{{name}}' has remote changes. Pull inside the submodule, then try again.",
          { name }
        )
      : translate(
          'sourceControl.remoteError.submodule.remoteChanged',
          'A submodule has remote changes. Pull inside the submodule, then try again.'
        )
  }
  return name
    ? translate(
        'sourceControl.remoteError.submodule.namedPushFailed',
        "Submodule '{{name}}' could not be pushed. Resolve the submodule push error, then try again.",
        { name }
      )
    : translate(
        'sourceControl.remoteError.submodule.pushFailed',
        'A submodule could not be pushed. Resolve the submodule push error, then try again.'
      )
}

// Detail is a whole sentence (translated Orca copy or verbatim git output).
export function operationFailedWithDetail(operation: RemoteOperation, detail: string): string {
  switch (operation) {
    case 'publish':
      return translate(
        'sourceControl.remoteError.failedWithDetail.publish',
        'Publish Branch failed. {{detail}}',
        { detail }
      )
    case 'sync':
      return translate(
        'sourceControl.remoteError.failedWithDetail.sync',
        'Sync failed. {{detail}}',
        {
          detail
        }
      )
    case 'forcePush':
      return translate(
        'sourceControl.remoteError.failedWithDetail.forcePush',
        'Force Push failed. {{detail}}',
        { detail }
      )
    case 'push':
      return translate(
        'sourceControl.remoteError.failedWithDetail.push',
        'Push failed. {{detail}}',
        {
          detail
        }
      )
    case 'fetch':
      return translate(
        'sourceControl.remoteError.failedWithDetail.fetch',
        'Fetch failed. {{detail}}',
        { detail }
      )
    case 'fastForward':
      return translate(
        'sourceControl.remoteError.failedWithDetail.fastForward',
        'Fast-forward failed. {{detail}}',
        { detail }
      )
    case 'rebase':
      return translate(
        'sourceControl.remoteError.failedWithDetail.rebase',
        'Rebase failed. {{detail}}',
        { detail }
      )
    case 'pull':
      return translate(
        'sourceControl.remoteError.failedWithDetail.pull',
        'Pull failed. {{detail}}',
        {
          detail
        }
      )
  }
}

export function pushHookBlockedMessage(operation: PushLikeOperation, summary: string): string {
  if (summary === LINT_PUSH_FAILURE_SUMMARY) {
    switch (operation) {
      case 'publish':
        return translate(
          'sourceControl.remoteError.hookBlocked.lint.publish',
          'Publish Branch blocked — lint failed during push.'
        )
      case 'sync':
        return translate(
          'sourceControl.remoteError.hookBlocked.lint.sync',
          'Sync blocked — lint failed during push.'
        )
      case 'forcePush':
        return translate(
          'sourceControl.remoteError.hookBlocked.lint.forcePush',
          'Force Push blocked — lint failed during push.'
        )
      case 'push':
        return translate(
          'sourceControl.remoteError.hookBlocked.lint.push',
          'Push blocked — lint failed during push.'
        )
    }
  }
  if (summary === PRE_PUSH_FAILURE_SUMMARY) {
    switch (operation) {
      case 'publish':
        return translate(
          'sourceControl.remoteError.hookBlocked.prePush.publish',
          'Publish Branch blocked — pre-push hook failed.'
        )
      case 'sync':
        return translate(
          'sourceControl.remoteError.hookBlocked.prePush.sync',
          'Sync blocked — pre-push hook failed.'
        )
      case 'forcePush':
        return translate(
          'sourceControl.remoteError.hookBlocked.prePush.forcePush',
          'Force Push blocked — pre-push hook failed.'
        )
      case 'push':
        return translate(
          'sourceControl.remoteError.hookBlocked.prePush.push',
          'Push blocked — pre-push hook failed.'
        )
    }
  }
  // Raw hook output line; lowercase its first letter to read as a clause after the dash.
  const detail = `${summary.charAt(0).toLowerCase()}${summary.slice(1)}`
  switch (operation) {
    case 'publish':
      return translate(
        'sourceControl.remoteError.hookBlocked.detail.publish',
        'Publish Branch blocked — {{detail}}',
        { detail }
      )
    case 'sync':
      return translate(
        'sourceControl.remoteError.hookBlocked.detail.sync',
        'Sync blocked — {{detail}}',
        {
          detail
        }
      )
    case 'forcePush':
      return translate(
        'sourceControl.remoteError.hookBlocked.detail.forcePush',
        'Force Push blocked — {{detail}}',
        { detail }
      )
    case 'push':
      return translate(
        'sourceControl.remoteError.hookBlocked.detail.push',
        'Push blocked — {{detail}}',
        {
          detail
        }
      )
  }
}

export function remoteAccessFailedMessage(
  operation: PushLikeOperation,
  detail: string | null
): string {
  if (detail) {
    switch (operation) {
      case 'publish':
        return translate(
          'sourceControl.remoteError.remoteAccessWithDetail.publish',
          'Publish Branch failed. {{detail}}. Check your remote access and try again.',
          { detail }
        )
      case 'sync':
        return translate(
          'sourceControl.remoteError.remoteAccessWithDetail.sync',
          'Sync failed. {{detail}}. Check your remote access and try again.',
          { detail }
        )
      case 'forcePush':
        return translate(
          'sourceControl.remoteError.remoteAccessWithDetail.forcePush',
          'Force Push failed. {{detail}}. Check your remote access and try again.',
          { detail }
        )
      case 'push':
        return translate(
          'sourceControl.remoteError.remoteAccessWithDetail.push',
          'Push failed. {{detail}}. Check your remote access and try again.',
          { detail }
        )
    }
  }
  switch (operation) {
    case 'publish':
      return translate(
        'sourceControl.remoteError.publishFailed',
        'Publish Branch failed. Check your remote access and try again.'
      )
    case 'sync':
      return translate(
        'sourceControl.remoteError.syncFailed',
        'Sync failed. Check your connection and try again.'
      )
    case 'forcePush':
      return translate(
        'sourceControl.remoteError.forcePushFailed',
        'Force Push failed. Check your connection and try again.'
      )
    case 'push':
      return translate(
        'sourceControl.remoteError.pushFailed',
        'Push failed. Check your connection and try again.'
      )
  }
}

export function localChangesBlockedMessage(operation: PullLikeOperation): string {
  if (operation === 'rebase') {
    return translate(
      'sourceControl.remoteError.localChangesBlocked.rebase',
      'Rebase blocked — commit or stash your local changes first.'
    )
  }
  if (operation === 'fastForward') {
    return translate(
      'sourceControl.remoteError.localChangesBlocked.fastForward',
      'Fast-forward blocked — commit or stash your local changes first.'
    )
  }
  return translate(
    'sourceControl.remoteError.localChangesBlocked.pull',
    'Pull blocked — commit or stash your local changes first.'
  )
}

export function untrackedFilesBlockedMessage(operation: PullLikeOperation): string {
  if (operation === 'rebase') {
    return translate(
      'sourceControl.remoteError.untrackedFilesBlocked.rebase',
      'Rebase blocked — move, remove, or add untracked files first.'
    )
  }
  if (operation === 'fastForward') {
    return translate(
      'sourceControl.remoteError.untrackedFilesBlocked.fastForward',
      'Fast-forward blocked — move, remove, or add untracked files first.'
    )
  }
  return translate(
    'sourceControl.remoteError.untrackedFilesBlocked.pull',
    'Pull blocked — move, remove, or add untracked files first.'
  )
}

export function mergeConflictsMessage(operation: PullLikeOperation): string {
  if (operation === 'rebase') {
    return translate(
      'sourceControl.remoteError.mergeConflicts.rebase',
      'Rebase stopped with conflicts. Resolve them in Source Control, then continue the rebase.'
    )
  }
  return operation === 'sync'
    ? translate(
        'sourceControl.remoteError.mergeConflicts.sync',
        'Sync stopped with merge conflicts. Resolve them in Source Control, then commit the merge.'
      )
    : translate(
        'sourceControl.remoteError.mergeConflicts.pull',
        'Pull stopped with merge conflicts. Resolve them in Source Control, then commit the merge.'
      )
}
