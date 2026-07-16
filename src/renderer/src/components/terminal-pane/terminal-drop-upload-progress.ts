import { translate } from '@/i18n/i18n'

export function getTerminalDropUploadProgress(
  count: number,
  destination: 'runtime' | 'remote'
): string {
  // Why: destinations and noun forms must stay inside complete translation
  // units so translators can reorder the whole progress message.
  if (destination === 'runtime') {
    return count === 1
      ? translate(
          'auto.components.terminal.pane.terminal.drop.handler.uploadingOneFileToRuntime',
          'Uploading {{count}} file to runtime…',
          { count }
        )
      : translate(
          'auto.components.terminal.pane.terminal.drop.handler.uploadingManyFilesToRuntime',
          'Uploading {{count}} files to runtime…',
          { count }
        )
  }
  return count === 1
    ? translate(
        'auto.components.terminal.pane.terminal.drop.handler.uploadingOneFileToRemote',
        'Uploading {{count}} file to remote…',
        { count }
      )
    : translate(
        'auto.components.terminal.pane.terminal.drop.handler.uploadingManyFilesToRemote',
        'Uploading {{count}} files to remote…',
        { count }
      )
}
