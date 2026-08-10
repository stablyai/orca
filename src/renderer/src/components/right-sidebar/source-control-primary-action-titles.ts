import { translate } from '@/i18n/i18n'

export function describePushCount(ahead: number): string {
  return ahead === 1
    ? translate(
        'auto.components.rightSidebar.sourceControl.pushCount.one',
        'Push {{count}} commit',
        { count: ahead }
      )
    : translate(
        'auto.components.rightSidebar.sourceControl.pushCount.other',
        'Push {{count}} commits',
        { count: ahead }
      )
}

export function describePullCount(behind: number): string {
  return behind === 1
    ? translate(
        'auto.components.rightSidebar.sourceControl.pullCount.one',
        'Pull {{count}} commit',
        { count: behind }
      )
    : translate(
        'auto.components.rightSidebar.sourceControl.pullCount.other',
        'Pull {{count}} commits',
        { count: behind }
      )
}

export function describeFastForwardCount(behind: number): string {
  return behind === 1
    ? translate(
        'auto.components.rightSidebar.sourceControl.fastForwardCount.one',
        'Fast-forward {{count}} commit',
        { count: behind }
      )
    : translate(
        'auto.components.rightSidebar.sourceControl.fastForwardCount.other',
        'Fast-forward {{count}} commits',
        { count: behind }
      )
}

export function describeSyncCounts(ahead: number, behind: number): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.syncCounts',
    'Pull {{behind}}, push {{ahead}}',
    { ahead, behind }
  )
}

export function describeForcePushWithLease(
  count: number | undefined,
  upstreamName?: string
): string {
  const remoteTarget =
    upstreamName ??
    translate('auto.components.rightSidebar.sourceControl.theRemoteBranch', 'the remote branch')
  const countText =
    count && count > 0
      ? count === 1
        ? translate(
            'auto.components.rightSidebar.sourceControl.branchCommit.one',
            '{{count}} branch commit',
            { count }
          )
        : translate(
            'auto.components.rightSidebar.sourceControl.branchCommit.other',
            '{{count}} branch commits',
            { count }
          )
      : translate('auto.components.rightSidebar.sourceControl.thisBranch', 'this branch')
  return translate(
    'auto.components.rightSidebar.sourceControl.forcePushOlderRemote',
    'Remote only has older copies of local commits. Force push {{countText}} with lease to update {{remoteTarget}}.',
    { countText, remoteTarget }
  )
}

export function formatManualForcePushTitle(
  ahead: number,
  behind: number,
  upstreamName?: string
): string {
  const remoteTarget =
    upstreamName ??
    translate('auto.components.rightSidebar.sourceControl.theRemoteBranch', 'the remote branch')
  const commitText =
    ahead === 1
      ? translate('auto.components.rightSidebar.sourceControl.localCommit.one', '1 local commit')
      : translate(
          'auto.components.rightSidebar.sourceControl.localCommit.other',
          '{{count}} local commits',
          { count: ahead }
        )
  if (behind > 0) {
    return translate(
      'auto.components.rightSidebar.sourceControl.forcePushReplaceRemote',
      'Force push {{commitText}} with lease to update {{remoteTarget}} and replace remote-only commits.',
      { commitText, remoteTarget }
    )
  }
  return translate(
    'auto.components.rightSidebar.sourceControl.forcePushUpdateRemote',
    'Force push {{commitText}} with lease to update {{remoteTarget}}.',
    { commitText, remoteTarget }
  )
}

export function formatUnpublishedForcePushTitle(branchCommitsAhead: number | undefined): string {
  const countText =
    branchCommitsAhead && branchCommitsAhead > 0
      ? branchCommitsAhead === 1
        ? translate(
            'auto.components.rightSidebar.sourceControl.branchCommit.one',
            '{{count}} branch commit',
            { count: branchCommitsAhead }
          )
        : translate(
            'auto.components.rightSidebar.sourceControl.branchCommit.other',
            '{{count}} branch commits',
            { count: branchCommitsAhead }
          )
      : translate('auto.components.rightSidebar.sourceControl.thisBranch', 'this branch')
  return translate(
    'auto.components.rightSidebar.sourceControl.forcePushSetUpstream',
    'Force push {{countText}} with lease and set an upstream if needed.',
    { countText }
  )
}

export function nothingToPullTitle(): string {
  return translate('auto.components.rightSidebar.sourceControl.nothingToPull', 'Nothing to pull')
}

export function nothingToFastForwardTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.nothingToFastForward',
    'Nothing to fast-forward'
  )
}

export function tryRebasingDirtyTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.tryRebasingDirty',
    'Try rebasing; git may require committing or stashing local changes first'
  )
}

export function branchAlreadyPublishedTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.branchAlreadyPublished',
    'Branch is already published'
  )
}

export function switchToFeatureBranchHint(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.switchToFeatureBranch',
    'Switch to a feature branch'
  )
}

export function stageAtLeastOneFileToCommitTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.stageAtLeastOneFileToCommit',
    'Stage at least one file to commit'
  )
}
