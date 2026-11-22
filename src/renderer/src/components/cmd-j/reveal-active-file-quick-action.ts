import { FolderSearch } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { CmdJQuickAction } from './quick-actions'

export function getRevealActiveFileQuickAction(): CmdJQuickAction {
  return {
    id: 'fileExplorer.revealActiveFile',
    kind: 'action',
    title: translate(
      'keybindings.title.fileExplorerRevealActiveFile',
      'Reveal Active File in Explorer'
    ),
    description: translate(
      'auto.components.cmd.j.quick.actions.revealActiveFileDescription',
      'Select the active editor file in the file explorer.'
    ),
    icon: FolderSearch,
    verbKeywords: [
      translate('auto.components.cmd.j.quick.actions.verbs.revealActiveFile', 'reveal active file'),
      translate(
        'auto.components.cmd.j.quick.actions.verbs.revealActiveFileInExplorer',
        'reveal active file in explorer'
      ),
      translate('auto.components.cmd.j.quick.actions.verbs.revealInExplorer', 'reveal in explorer'),
      translate('auto.components.cmd.j.quick.actions.verbs.locateActiveFile', 'locate active file')
    ],
    isAvailable: (ctx) =>
      ctx.canRevealActiveFileInExplorer
        ? { available: true }
        : { available: false, reason: 'no-active-file' },
    run: async (ctx) => {
      if (!ctx.canRevealActiveFileInExplorer || !ctx.revealActiveFileInExplorer?.()) {
        return { status: 'unavailable', reason: 'no-active-file' }
      }
      return { status: 'ok' }
    }
  }
}
