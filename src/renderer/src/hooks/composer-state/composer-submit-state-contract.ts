import type { ComposerModel } from './composer-model'
export type ComposerSubmitState = {
  folderSubmitOrchestration: Pick<ComposerModel, 'submitFolderTarget'>
  fullSubmitSourcePreparation: Pick<ComposerModel, 'prepareFullSubmitSource'>
  fullSubmitPreparation: Pick<ComposerModel, 'prepareFullSubmit'>
  fullCreationExecution: Pick<ComposerModel, 'executeFullCreation'>
  fullSubmitOrchestration: Pick<ComposerModel, 'submit'>
  multipleCreateReset: Pick<ComposerModel, 'resetForNextCreate'>
  quickSubmitSourcePreparation: Pick<ComposerModel, 'prepareQuickSubmitSource'>
  quickSubmitPreparation: Pick<ComposerModel, 'prepareQuickSubmit'>
  quickCreationExecution: Pick<ComposerModel, 'executeQuickCreation'>
  quickSubmitAction: Pick<ComposerModel, 'submitQuick'>
}
