import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'

export function structuredSessionQueuedMessage(entry: StructuredAgentSessionOutboxEntry) {
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
        : entry.state === 'dispatching'
          ? ('submitting' as const)
          : ('pending' as const),
    canEdit: entry.state === 'queued',
    canRemove: entry.state === 'queued'
  }
}
