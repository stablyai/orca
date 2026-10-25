// Why: label/title wording for the dropdown rows, kept apart from the priority ladder so copy edits
// do not touch the state machine.
import { translate } from '@/i18n/i18n'

export function describePushCount(ahead: number): string {
  return translate('sourceControl.actions.pushCount', 'Push {{count}} commits', {
    count: ahead,
    defaultValue_one: 'Push {{count}} commit'
  })
}

export function describePullCount(behind: number): string {
  return translate('sourceControl.actions.pullCount', 'Pull {{count}} commits', {
    count: behind,
    defaultValue_one: 'Pull {{count}} commit'
  })
}

export function describeFastForwardCount(behind: number): string {
  return translate('sourceControl.actions.fastForwardCount', 'Fast-forward {{count}} commits', {
    count: behind,
    defaultValue_one: 'Fast-forward {{count}} commit'
  })
}

export function describeSyncCounts(ahead: number, behind: number): string {
  return translate('sourceControl.actions.syncCounts', 'Pull {{behind}}, push {{ahead}}', {
    behind,
    ahead
  })
}

export function formatCountLabel(base: string, count: number): string {
  return count > 0 ? `${base} (${count})` : base
}

export function formatSyncLabel(base: string, ahead: number, behind: number): string {
  if (ahead === 0 && behind === 0) {
    return base
  }
  return `${base} (↓${behind} ↑${ahead})`
}

export function formatForcePushTitle(
  branchCommitsAhead: number | undefined,
  upstreamName?: string
): string {
  const upstream =
    upstreamName ?? translate('sourceControl.actions.remoteBranch', 'the remote branch')
  return branchCommitsAhead && branchCommitsAhead > 0
    ? translate(
        'sourceControl.actions.forcePushCount',
        'Remote only has older copies of local commits. Force push {{count}} branch commits with lease to update {{upstream}}.',
        {
          count: branchCommitsAhead,
          upstream,
          defaultValue_one:
            'Remote only has older copies of local commits. Force push {{count}} branch commit with lease to update {{upstream}}.'
        }
      )
    : translate(
        'sourceControl.actions.forcePushBranch',
        'Remote only has older copies of local commits. Force push this branch with lease to update {{upstream}}.',
        { upstream }
      )
}

export function formatManualForcePushTitle(
  ahead: number,
  behind: number,
  upstreamName?: string
): string {
  const upstream =
    upstreamName ?? translate('sourceControl.actions.remoteBranch', 'the remote branch')
  if (behind > 0) {
    return translate(
      'sourceControl.actions.manualForcePushReplace',
      'Force push {{count}} local commits with lease to update {{upstream}} and replace remote-only commits.',
      {
        count: ahead,
        upstream,
        defaultValue_one:
          'Force push {{count}} local commit with lease to update {{upstream}} and replace remote-only commits.'
      }
    )
  }
  return translate(
    'sourceControl.actions.manualForcePush',
    'Force push {{count}} local commits with lease to update {{upstream}}.',
    {
      count: ahead,
      upstream,
      defaultValue_one: 'Force push {{count}} local commit with lease to update {{upstream}}.'
    }
  )
}

export function formatUnpublishedForcePushTitle(branchCommitsAhead: number | undefined): string {
  return branchCommitsAhead && branchCommitsAhead > 0
    ? translate(
        'sourceControl.actions.unpublishedForcePushCount',
        'Force push {{count}} branch commits with lease and set an upstream if needed.',
        {
          count: branchCommitsAhead,
          defaultValue_one:
            'Force push {{count}} branch commit with lease and set an upstream if needed.'
        }
      )
    : translate(
        'sourceControl.actions.unpublishedForcePushBranch',
        'Force push this branch with lease and set an upstream if needed.'
      )
}

export function formatRebaseBaseRef(baseRef: string): string {
  return baseRef.replace(/^refs\/remotes\//, '').replace(/^remotes\//, '')
}
