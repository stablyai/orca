import { translate } from '@/i18n/i18n'
import type { NativeChatComposerNotice } from './native-chat-composer-notice'
import type { StructuredAgentSessionQueuedMessagesController } from './use-structured-agent-session-queued-messages'
import { codexMaintenanceRecoveryAction } from '../../../../shared/codex-maintenance-recovery'

export function codexMaintenanceRecoveryNotice(
  retryLaunch: (() => void) | null,
  queue: Pick<StructuredAgentSessionQueuedMessagesController, 'cards' | 'steer' | 'queueResume'>
): NativeChatComposerNotice {
  const recovery = codexMaintenanceRecoveryAction(
    retryLaunch !== null,
    queue.cards,
    Boolean(queue.queueResume)
  )
  const action: NativeChatComposerNotice['action'] =
    recovery.kind === 'launch' && retryLaunch
      ? {
          label: translate('auto.components.native.chat.NativeChatLaunchRetry.retry', 'Retry'),
          onClick: retryLaunch
        }
      : recovery.kind === 'message'
        ? {
            label: translate('components.native-chat.queuedMessages.send', 'Send'),
            onClick: () => {
              void queue.steer(recovery.messageId)
            }
          }
        : recovery.kind === 'queue' && queue.queueResume
          ? {
              label: translate('components.native-chat.queuedMessages.resume', 'Resume'),
              disabled: queue.queueResume.resuming,
              onClick: () => {
                void queue.queueResume?.resume()
              }
            }
          : undefined
  return {
    key: 'codex-installation',
    kind: 'error',
    text:
      recovery.kind === 'launch' || recovery.kind === 'queue'
        ? translate('codex.maintenance.updatedRetry', 'Codex is updated. Retry.')
        : translate(
            'codex.maintenance.updatedSendAgain',
            'Codex is updated. Send your message again.'
          ),
    action
  }
}
