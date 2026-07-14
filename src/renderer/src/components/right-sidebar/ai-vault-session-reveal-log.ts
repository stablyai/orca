import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { resolveAiVaultRevealLogAction } from './ai-vault-session-path-actions'

// Why: web chat / OpenCode-SQLite sessions carry a synthetic `<db>#<id>` path.
// shell.openPath silently fails on that string, so reveal the backing db in the
// file manager instead; real transcript paths open directly as before.
export async function revealAiVaultSessionLog(
  session: Pick<AiVaultSession, 'filePath'>
): Promise<void> {
  const action = resolveAiVaultRevealLogAction(session.filePath)
  if (action.kind === 'open') {
    await window.api.shell.openPath(action.path)
    return
  }
  const result = await window.api.shell.openInFileManager(action.path)
  if (!result.ok) {
    toast.error(
      translate(
        'auto.components.right.sidebar.AiVaultPanel.revealLogFailed',
        'Could not open the log location.'
      )
    )
  }
}
