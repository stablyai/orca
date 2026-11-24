import { useCallback } from 'react'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { toast } from 'sonner'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import { botToolErrorMessage } from '../bot-tools-client'
import { removeComposioKey } from './composio-client'

/** The key line's Remove: forgets the owner's key for every bot, once the owner confirms. */
export function useRemoveComposioKey(hostId: ExecutionHostId): () => Promise<void> {
  const confirm = useConfirmationDialog()
  return useCallback(async () => {
    let alsoEvents = false
    const yes = await confirm({
      title: translate('bots.composio.removeKey.title', 'Remove your Composio key?'),
      description: translate(
        'bots.composio.removeKey.description',
        'Your bots lose their Composio apps. Your app sign-ins stay at Composio.'
      ),
      confirmLabel: translate('bots.composio.remove', 'Remove'),
      confirmVariant: 'destructive',
      // Without the key, Orca can't turn them off later; events would start bots with no apps.
      dontAskAgain: {
        label: translate(
          'bots.composio.removeKey.alsoEvents',
          'Also turn off Composio events (every bot’s triggers and the project’s events address)'
        ),
        onConfirmed: () => {
          alsoEvents = true
        }
      }
    })
    if (yes) {
      await removeComposioKey(hostId, { alsoEvents }).catch((error: unknown) =>
        toast.error(botToolErrorMessage(error))
      )
    }
  }, [confirm, hostId])
}
