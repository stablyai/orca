import { useCallback } from 'react'
import { toast } from 'sonner'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { translate } from '@/i18n/i18n'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { agentLabel } from './ai-vault-session-filters'

export function useAiVaultSessionDeleteAction({
  refresh,
  onDeleted
}: {
  refresh: (options: { force: boolean }) => Promise<void>
  onDeleted?: (session: AiVaultSession) => void
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
          sessionId: session.sessionId,
          filePath: session.filePath,
          executionHostId: session.executionHostId
        })
        if (result.outcome !== 'deleted') {
          // Use one failure message rather than exposing raw main-side reasons.
          throw new Error(result.outcome)
        }
        onDeleted?.(session)
        toast.success(
          translate('auto.components.right.sidebar.AiVaultPanel.sessionDeleted', 'Session deleted')
        )
        // Main already invalidated its caches; this is only for immediate UX.
        void refresh({ force: true })
      } catch {
        toast.error(
          translate(
            'auto.components.right.sidebar.AiVaultPanel.sessionDeleteFailed',
            "Couldn't delete the session"
          )
        )
      }
    },
    [confirm, refresh, onDeleted]
  )
}
