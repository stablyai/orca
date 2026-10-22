import { translate } from '@/i18n/i18n'

export function getTerminalInternalFileDropRejectionMessage(
  reason: 'paths-too-large' | 'too-many-paths' | 'source-host-mismatch'
): string {
  if (reason === 'source-host-mismatch') {
    return translate(
      'auto.components.terminal.pane.terminal.drop.handler.internalHostMismatch',
      'Drop files from the same host as this terminal.'
    )
  }
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
