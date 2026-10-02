import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { translate } from '@/i18n/i18n'

export function structuredSessionQueuedMessage(
  entry: StructuredAgentSessionOutboxEntry,
  retryableId: string | null = null
) {
  const canRetry = entry.clientMessageId === retryableId
  const imagePaths = entry.body.blocks.flatMap((block) =>
    block.type === 'image-ref' && block.path ? [block.path] : []
  )
  return {
    id: entry.clientMessageId,
    text: entry.body.blocks
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n'),
    imagePaths,
    state:
      entry.state === 'unconfirmed'
        ? ('uncertain' as const)
        : canRetry
          ? ('paused' as const)
          : entry.state === 'dispatching'
            ? ('submitting' as const)
            : ('pending' as const),
    canRetry,
    ...(canRetry
      ? {
          detail:
            entry.state === 'unconfirmed'
              ? translate(
                  'auto.components.native.chat.NativeChatStructuredSession.1f772bb5d0',
                  'Message delivery is unconfirmed.'
                )
              : translate(
                  'auto.components.native.chat.NativeChatStructuredSession.93ef441197',
                  'Message was not sent.'
                )
        }
      : {}),
    canEdit: entry.state === 'queued',
    canRemove: entry.state === 'queued'
  }
}
