import { translate } from '@/i18n/i18n'
import type { ProjectGroupImportProjectResult } from '../../../../../../shared/project-group-types'

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
