import { translate } from '@/i18n/i18n'

export function addRepoScanningRepositoriesLabel(): string {
  return translate(
    'auto.components.sidebar.AddRepoDialog.scanningForRepositories',
    'Scanning for repositories...'
  )
}

export function addRepoOpeningProjectLabel(): string {
  return translate('auto.components.sidebar.AddRepoDialog.openingProject', 'Opening project...')
}

export function addRepoOpeningFolderLabel(): string {
  return translate('auto.components.sidebar.AddRepoDialog.openingFolder', 'Opening folder...')
}

export function addRepoChooseFolderLabel(): string {
  return translate('auto.components.sidebar.AddRepoDialog.chooseAFolder', 'Choose a folder...')
}
