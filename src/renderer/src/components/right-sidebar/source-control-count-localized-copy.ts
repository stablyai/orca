import { translate } from '@/i18n/i18n'

export function localizedPushCount(ahead: number): string {
  return translate(
    'auto.components.right.sidebar.source.control.dropdown.items.pushCount',
    'Push {{count}} commits',
    { count: ahead, defaultValue_one: 'Push {{count}} commit' }
  )
}

export function localizedPullCount(behind: number): string {
  return translate(
    'auto.components.right.sidebar.source.control.dropdown.items.pullCount',
    'Pull {{count}} commits',
    { count: behind, defaultValue_one: 'Pull {{count}} commit' }
  )
}

export function localizedFastForwardCount(behind: number): string {
  return translate(
    'auto.components.right.sidebar.source.control.dropdown.items.fastForwardCount',
    'Fast-forward {{count}} commits',
    { count: behind, defaultValue_one: 'Fast-forward {{count}} commit' }
  )
}

export function localizedSyncCounts(ahead: number, behind: number): string {
  return translate(
    'auto.components.right.sidebar.source.control.dropdown.items.syncCounts',
    'Pull {{behind}}, push {{ahead}}',
    { ahead, behind }
  )
}

function localizedUpstreamName(upstreamName: string | undefined): string {
  return (
    upstreamName ??
    translate(
      'auto.components.right.sidebar.source.control.dropdown.items.remoteBranchFallback',
      'the remote branch'
    )
  )
}

export function localizedForcePushWithLease(
  branchCommitsAhead: number | undefined,
  upstreamName?: string
): string {
  const target = localizedUpstreamName(upstreamName)
  if (!branchCommitsAhead || branchCommitsAhead <= 0) {
    return translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleForcePushOlderCopiesBranch',
      'Remote only has older copies of local commits. Force push this branch with lease to update {{upstreamName}}.',
      { upstreamName: target }
    )
  }
  return translate(
    'auto.components.right.sidebar.source.control.dropdown.items.titleForcePushOlderCopiesCount',
    'Remote only has older copies of local commits. Force push {{count}} branch commits with lease to update {{upstreamName}}.',
    {
      count: branchCommitsAhead,
      upstreamName: target,
      defaultValue_one:
        'Remote only has older copies of local commits. Force push {{count}} branch commit with lease to update {{upstreamName}}.'
    }
  )
}

export function localizedManualForcePush(
  ahead: number,
  behind: number,
  upstreamName?: string
): string {
  const target = localizedUpstreamName(upstreamName)
  if (behind > 0) {
    return translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleManualForcePushReplaceRemote',
      'Force push {{count}} local commits with lease to update {{upstreamName}} and replace remote-only commits.',
      {
        count: ahead,
        upstreamName: target,
        defaultValue_one:
          'Force push {{count}} local commit with lease to update {{upstreamName}} and replace remote-only commits.'
      }
    )
  }
  return translate(
    'auto.components.right.sidebar.source.control.dropdown.items.titleManualForcePush',
    'Force push {{count}} local commits with lease to update {{upstreamName}}.',
    {
      count: ahead,
      upstreamName: target,
      defaultValue_one: 'Force push {{count}} local commit with lease to update {{upstreamName}}.'
    }
  )
}

export function localizedUnpublishedForcePush(branchCommitsAhead: number | undefined): string {
  if (!branchCommitsAhead || branchCommitsAhead <= 0) {
    return translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleUnpublishedForcePushBranch',
      'Force push this branch with lease and set an upstream if needed.'
    )
  }
  return translate(
    'auto.components.right.sidebar.source.control.dropdown.items.titleUnpublishedForcePushCount',
    'Force push {{count}} branch commits with lease and set an upstream if needed.',
    {
      count: branchCommitsAhead,
      defaultValue_one:
        'Force push {{count}} branch commit with lease and set an upstream if needed.'
    }
  )
}
