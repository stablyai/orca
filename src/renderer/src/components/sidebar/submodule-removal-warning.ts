import { translate } from '@/i18n/i18n'

export function getSubmoduleRemovalWarning(): string {
  return translate(
    'auto.components.sidebar.delete.worktree.toast.submodules',
    'Force Delete may permanently discard submodule files and unpublished commits.'
  )
}
