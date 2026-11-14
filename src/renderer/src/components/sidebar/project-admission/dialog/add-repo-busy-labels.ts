import { translate } from '@/i18n/i18n'

export const addRepoBusyLabels = {
  scanningRepositories: (): string =>
    translate(
      'auto.components.sidebar.addRepoBusyLabels.scanningRepositories',
      'Scanning for repositories...'
    ),
  openingProject: (): string =>
    translate('auto.components.sidebar.addRepoBusyLabels.openingProject', 'Opening project...'),
  openingFolder: (): string =>
    translate('auto.components.sidebar.addRepoBusyLabels.openingFolder', 'Opening folder...'),
  chooseFolder: (): string =>
    translate('auto.components.sidebar.addRepoBusyLabels.chooseFolder', 'Choose a folder...')
}
