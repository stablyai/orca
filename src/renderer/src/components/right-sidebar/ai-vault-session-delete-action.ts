import { useCallback } from 'react'
import { toast } from 'sonner'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { translate } from '@/i18n/i18n'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { agentLabel } from './ai-vault-session-filters'

/**
 * Confirms, then deletes an AI Vault session: toasts the outcome and forces a
 * refresh so the row goes away immediately.
 */
export function useAiVaultSessionDeleteAction({
  refresh
}: {
  refresh: (options: { force: boolean }) => Promise<void>
}): (session: AiVaultSession) => Promise<void> {
  const confirm = useConfirmationDialog()

  return useCallback(
    async (session: AiVaultSession) => {
      const confirmed = await confirm({
        title: translate(
          'auto.components.right.sidebar.AiVaultSessionDeleteDialog.title',
          'Delete this session?'
        ),
        description: translate(
          'auto.components.right.sidebar.AiVaultSessionDeleteDialog.description',
          '"{{value0}}" will be deleted. Once deleted, it will no longer be resumable from {{value1}}\'s own command line either.',
          { value0: session.title, value1: agentLabel(session.agent) }
        ),
        confirmLabel: translate(
          'auto.components.right.sidebar.AiVaultSessionDeleteDialog.confirm',
          'Delete'
        ),
        confirmVariant: 'destructive'
      })
      if (!confirmed) {
        return
      }
      try {
        const result = await window.api.aiVault.deleteSession({
          agent: session.agent,
          filePath: session.filePath,
          executionHostId: session.executionHostId
        })
        if (result.outcome !== 'deleted') {
          // 'rejected' and 'failed' share one message: the specific reason is a
          // main-side detail, not something to surface raw.
          throw new Error(result.outcome)
        }
        toast.success(
          translate('auto.components.right.sidebar.AiVaultPanel.sessionDeleted', 'Session deleted')
        )
        // Main already invalidated its caches; this is only for immediate UX.
        void refresh({ force: true })
      } catch {
        // A rejected IPC invoke (transport/serialization) lands here too.
        toast.error(
          translate(
            'auto.components.right.sidebar.AiVaultPanel.sessionDeleteFailed',
            "Couldn't delete the session"
          )
        )
      }
    },
    [confirm, refresh]
  )
}
