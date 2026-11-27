import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { ProjectGroupImportProjectResult } from '../../../../../../shared/project/groups/project-group-types'

export function nestedImportFailureDescription(
  failure: ProjectGroupImportProjectResult | undefined
): string | undefined {
  if (!failure?.errorCode) {
    return failure?.error
  }
  switch (failure.errorCode) {
    case 'not_in_scan':
      return translate(
        'nestedImport.error.notInScan',
        'Repository was not found in the nested repository scan result'
      )
    case 'not_git_repository':
      return translate('nestedImport.error.notGitRepository', 'Not a valid Git repository')
    case 'import_failed':
      return translate('nestedImport.error.importFailed', 'Repository could not be imported')
  }
  return failure.error
}

export function toastNoNestedRepositoriesImported(
  failure: ProjectGroupImportProjectResult | undefined
): void {
  toast.error(
    translate(
      'auto.components.sidebar.useAddRepoNestedImportFlow.1b33c5f090',
      'No repositories imported'
    ),
    { description: nestedImportFailureDescription(failure) }
  )
}

export function toastSomeNestedRepositoriesFailed(failedCount: number): void {
  toast.warning(
    translate(
      'auto.components.sidebar.useAddRepoNestedImportFlow.cbfbc7a797',
      'Some repositories could not be imported'
    ),
    {
      description: translate(
        'auto.components.sidebar.useAddRepoNestedImportFlow.680cac2c82',
        '{{value0}} failed',
        { value0: failedCount }
      )
    }
  )
}
