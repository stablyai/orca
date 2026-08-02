import { translate } from '@/i18n/i18n'

export function getTerminalInternalFileDropRejectionMessage(
  reason: 'paths-too-large' | 'too-many-paths'
): string {
  if (reason === 'too-many-paths') {
    return translate(
      'auto.components.terminal.pane.terminal.drop.handler.internalTooManyPaths',
      'Drop contains too many paths for a safe terminal paste.'
    )
  }
  return translate(
    'auto.components.terminal.pane.terminal.drop.handler.internalPathsTooLarge',
    'Drop path list is too large for a safe terminal paste.'
  )
}
