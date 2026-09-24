import { useCallback } from 'react'
import { toast } from 'sonner'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { translate } from '@/i18n/i18n'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { activateAiVaultStructuredSession } from '@/lib/activate-ai-vault-structured-session'
import { agentLabel } from './ai-vault-session-filters'

/**
 * Confirms, then deletes an AI Vault session: toasts the outcome and forces a
 * refresh so the row goes away immediately.
 */
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
        // Two refusals name something the user can act on, so they get their own
        // copy and an exit. Every other reason stays a main-side detail.
        if (
          result.outcome === 'rejected' &&
          result.reason === 'structured-session-owned' &&
          result.structuredSession
        ) {
          const structuredSession = result.structuredSession
          toast.error(
            translate(
              'auto.components.right.sidebar.AiVaultPanel.sessionDeleteOwned',
              'This conversation belongs to a chat, so its history was kept'
            ),
            {
              action: {
                label: translate(
                  'auto.components.right.sidebar.AiVaultPanel.sessionDeleteOpenChat',
                  'Open chat'
                ),
                onClick: () => void activateAiVaultStructuredSession({ structuredSession })
              }
            }
          )
          return
        }
        if (
          result.outcome === 'rejected' &&
          result.reason === 'structured-session-ownership-unknown'
        ) {
          toast.error(
            translate(
              'auto.components.right.sidebar.AiVaultPanel.sessionDeleteOwnershipUnknown',
              "Couldn't check whether this history belongs to a chat, so nothing was deleted"
            )
          )
          return
        }
        if (result.outcome !== 'deleted') {
          // 'rejected' and 'failed' share one message: the specific reason is a
          // main-side detail, not something to surface raw.
          throw new Error(result.outcome)
        }
        onDeleted?.(session)
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
    [confirm, refresh, onDeleted]
  )
}
