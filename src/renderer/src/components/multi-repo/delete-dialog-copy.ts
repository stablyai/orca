import { translate } from '@/i18n/i18n'
import type { MultiRepoDeleteResult } from '../../../../shared/multi-repo-workspace'
import type { DeleteRow } from './delete-dialog-model'

export function getDeleteTitle(name: string): string {
  return translate('auto.components.multiRepo.delete.title', 'Delete {{name}}?', { name })
}

export function getDeleteBody(repoCount: number): string {
  if (repoCount === 0) {
    return translate(
      'auto.components.multiRepo.delete.bodyEmpty',
      'This removes the workspace record and its folder if it is empty.'
    )
  }
  return translate(
    'auto.components.multiRepo.delete.body',
    'This removes {{count}} worktrees and the workspace folder if it is empty. Branches that are fully merged are deleted; branches with unmerged commits are kept.',
    { count: repoCount }
  )
}

export function getDeleteButtonLabel(
  repoCount: number,
  forcedCount: number,
  phase: 'confirm' | 'retry',
  failedCount: number
): string {
  if (phase === 'retry') {
    return translate('auto.components.multiRepo.delete.retryFailed', 'Retry {{n}} failed', {
      n: failedCount
    })
  }
  if (forcedCount > 0) {
    return forcedCount === 1
      ? translate(
          'auto.components.multiRepo.delete.discardOne',
          'Delete and discard changes in 1 repo'
        )
      : translate(
          'auto.components.multiRepo.delete.discardMany',
          'Delete and discard changes in {{n}} repos',
          { n: forcedCount }
        )
  }
  if (repoCount === 0) {
    return translate('auto.components.multiRepo.delete.confirmEmpty', 'Delete workspace')
  }
  return translate(
    'auto.components.multiRepo.delete.confirm',
    'Delete workspace and {{count}} worktrees',
    { count: repoCount }
  )
}

export function getRowStatusText(row: DeleteRow, checking: boolean): string {
  if (row.phase === 'removing') {
    return translate('auto.components.multiRepo.delete.removing', 'Removing…')
  }
  if (row.phase === 'removed') {
    return row.preservedBranch
      ? translate(
          'auto.components.multiRepo.delete.removedKept',
          'Removed. Branch {{branch}} kept',
          {
            branch: row.preservedBranch
          }
        )
      : translate('auto.components.multiRepo.delete.removed', 'Removed')
  }
  if (row.phase === 'failed') {
    return row.failureMessage || translate('auto.components.multiRepo.delete.failed', 'Failed')
  }
  if (checking) {
    return translate('auto.components.multiRepo.delete.checking', 'Checking…')
  }
  if (row.worktreeGone) {
    return translate(
      'auto.components.multiRepo.delete.gone',
      'Worktree already gone. Only the record is removed'
    )
  }
  return ''
}

export function getRowRiskText(row: DeleteRow): string | null {
  const parts: string[] = []
  if (row.dirtyCount === null) {
    parts.push(
      translate('auto.components.multiRepo.delete.dirtyUnknown', 'Could not check changes')
    )
  } else if (row.dirtyCount > 0) {
    parts.push(
      translate('auto.components.multiRepo.delete.dirty', '{{count}} uncommitted files', {
        count: row.dirtyCount
      })
    )
  }
  if (row.unpublishedCommitCount === null) {
    parts.push(
      translate('auto.components.multiRepo.delete.unpublishedUnknown', 'Could not check commits')
    )
  } else if (row.unpublishedCommitCount > 0) {
    parts.push(
      translate(
        'auto.components.multiRepo.delete.unpublished',
        '{{count}} unpublished commits on {{branch}}',
        { count: row.unpublishedCommitCount, branch: row.branchName }
      )
    )
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

export function getBranchNote(row: DeleteRow): string | null {
  if (row.branchKept === true) {
    return translate(
      'auto.components.multiRepo.delete.branchKept',
      'Branch will be kept: unmerged commits'
    )
  }
  if (row.branchKept === null) {
    return translate('auto.components.multiRepo.delete.branchUnknown', 'Could not check the branch')
  }
  return null
}

export function getForceLabel(row: DeleteRow): string {
  return translate('auto.components.multiRepo.delete.force', 'Discard changes in {{repo}}', {
    repo: row.label
  })
}

export function getRootKeptText(rootKept: NonNullable<MultiRepoDeleteResult['rootKept']>): string {
  return rootKept.reason === 'not_empty'
    ? translate(
        'auto.components.multiRepo.delete.folderKeptNotEmpty',
        'Folder kept: it contains files ({{path}})',
        { path: rootKept.path }
      )
    : rootKept.reason === 'not_owned'
      ? translate(
          'auto.components.multiRepo.delete.folderKeptNotOwned',
          'Folder kept: Orca did not create it ({{path}})',
          { path: rootKept.path }
        )
      : translate(
          'auto.components.multiRepo.delete.folderKeptFailed',
          'Folder kept: it could not be removed ({{path}})',
          { path: rootKept.path }
        )
}
