import { translate } from '@/i18n/i18n'

export function localizedPushCount(ahead: number): string {
  return ahead === 1
    ? translate(
        'auto.components.right.sidebar.source.control.dropdown.items.pushCount_one',
        'Push {{count}} commit',
        { count: ahead }
      )
    : translate(
        'auto.components.right.sidebar.source.control.dropdown.items.pushCount_other',
        'Push {{count}} commits',
        { count: ahead }
      )
}

export function localizedPullCount(behind: number): string {
  return behind === 1
    ? translate(
        'auto.components.right.sidebar.source.control.dropdown.items.pullCount_one',
        'Pull {{count}} commit',
        { count: behind }
      )
    : translate(
        'auto.components.right.sidebar.source.control.dropdown.items.pullCount_other',
        'Pull {{count}} commits',
        { count: behind }
      )
}

export function localizedFastForwardCount(behind: number): string {
  return behind === 1
    ? translate(
        'auto.components.right.sidebar.source.control.dropdown.items.fastForwardCount_one',
        'Fast-forward {{count}} commit',
        { count: behind }
      )
    : translate(
        'auto.components.right.sidebar.source.control.dropdown.items.fastForwardCount_other',
        'Fast-forward {{count}} commits',
        { count: behind }
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
  return branchCommitsAhead === 1
    ? translate(
        'auto.components.right.sidebar.source.control.dropdown.items.titleForcePushOlderCopiesCount_one',
        'Remote only has older copies of local commits. Force push {{count}} branch commit with lease to update {{upstreamName}}.',
        { count: branchCommitsAhead, upstreamName: target }
      )
    : translate(
        'auto.components.right.sidebar.source.control.dropdown.items.titleForcePushOlderCopiesCount_other',
        'Remote only has older copies of local commits. Force push {{count}} branch commits with lease to update {{upstreamName}}.',
        { count: branchCommitsAhead, upstreamName: target }
      )
}

export function localizedManualForcePush(
  ahead: number,
  behind: number,
  upstreamName?: string
): string {
  const target = localizedUpstreamName(upstreamName)
  if (behind > 0) {
    return ahead === 1
      ? translate(
          'auto.components.right.sidebar.source.control.dropdown.items.titleManualForcePushReplaceRemote_one',
          'Force push {{count}} local commit with lease to update {{upstreamName}} and replace remote-only commits.',
          { count: ahead, upstreamName: target }
        )
      : translate(
          'auto.components.right.sidebar.source.control.dropdown.items.titleManualForcePushReplaceRemote_other',
          'Force push {{count}} local commits with lease to update {{upstreamName}} and replace remote-only commits.',
          { count: ahead, upstreamName: target }
        )
  }
  return ahead === 1
    ? translate(
        'auto.components.right.sidebar.source.control.dropdown.items.titleManualForcePush_one',
        'Force push {{count}} local commit with lease to update {{upstreamName}}.',
        { count: ahead, upstreamName: target }
      )
    : translate(
        'auto.components.right.sidebar.source.control.dropdown.items.titleManualForcePush_other',
        'Force push {{count}} local commits with lease to update {{upstreamName}}.',
        { count: ahead, upstreamName: target }
      )
}

export function localizedUnpublishedForcePush(branchCommitsAhead: number | undefined): string {
  if (!branchCommitsAhead || branchCommitsAhead <= 0) {
    return translate(
      'auto.components.right.sidebar.source.control.dropdown.items.titleUnpublishedForcePushBranch',
      'Force push this branch with lease and set an upstream if needed.'
    )
  }
  return branchCommitsAhead === 1
    ? translate(
        'auto.components.right.sidebar.source.control.dropdown.items.titleUnpublishedForcePushCount_one',
        'Force push {{count}} branch commit with lease and set an upstream if needed.',
        { count: branchCommitsAhead }
      )
    : translate(
        'auto.components.right.sidebar.source.control.dropdown.items.titleUnpublishedForcePushCount_other',
        'Force push {{count}} branch commits with lease and set an upstream if needed.',
        { count: branchCommitsAhead }
      )
}
