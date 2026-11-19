import { nativeChatToolCategory } from '../../../../../../shared/native-chat/tools/native-chat-tool-icon'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'

type ProjectionMessage = Pick<NativeChatMessage, 'id' | 'blocks'> &
  Partial<Pick<NativeChatMessage, 'from' | 'role'>>

export class NativeChatGalleryProjectionLimitError extends Error {
  constructor() {
    super('Conversation image navigation exceeded its projection budget')
    this.name = 'NativeChatGalleryProjectionLimitError'
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Reject the whole revision before shared display producers can parse or traverse oversized input. */
export function assertNativeChatGalleryProjection(input: {
  message: ProjectionMessage
  workRun?: readonly NativeChatMessage[]
}): void {
  if ((input.workRun?.length ?? 0) > 512) {
    throw new NativeChatGalleryProjectionLimitError()
  }
  let nodes = 0
  let textUnits = 0
  let metadataUnits = 0
  let inputUnits = 0
  const metadata = (value: unknown): void => {
    if (typeof value === 'string') {
      metadataUnits += value.length
      if (metadataUnits > 65536) {
        throw new NativeChatGalleryProjectionLimitError()
      }
    }
  }
  const argument = (value: unknown): void => {
    if (typeof value === 'string') {
      inputUnits += value.length
      if (inputUnits > 65536) {
        throw new NativeChatGalleryProjectionLimitError()
      }
    }
  }
  const count = (length: number): void => {
    nodes += length
    if (nodes > 4096) {
      throw new NativeChatGalleryProjectionLimitError()
    }
  }
  const toolInput = (value: unknown): void => {
    if (typeof value === 'string') {
      argument(value)
      return
    }
    if (!record(value)) {
      return
    }
    for (const key of [
      'file_path',
      'filePath',
      'path',
      'notebook_path',
      'command',
      'cmd',
      'query',
      'pattern'
    ]) {
      const field = value[key]
      if (['command', 'cmd', 'query', 'pattern'].includes(key) && Array.isArray(field)) {
        count(field.length)
        for (const part of field) {
          argument(part)
        }
      } else {
        argument(field)
      }
    }
    if (Array.isArray(value.changes)) {
      count(value.changes.length)
      for (const change of value.changes) {
        if (record(change)) {
          argument(change.path)
        }
      }
    }
  }
  const seen = new WeakSet<object>()
  for (const message of [input.message, ...(input.workRun ?? [])]) {
    if (seen.has(message)) {
      continue
    }
    seen.add(message)
    count(message.blocks.length)
    const mail = message.from?.orchestration
    if (mail?.message === 'mail-notice' && mail.messages.length === 1) {
      metadata(mail.messages[0]?.messageId)
      metadata(mail.messages[0]?.from)
    }
    const only = message.blocks[0]
    const plainText =
      message.blocks.length === 1 &&
      only?.type === 'text' &&
      message.role !== 'user' &&
      !message.from &&
      !only.providerFrame &&
      !only.presentation &&
      !only.tone
    for (const block of message.blocks) {
      if (block.type === 'text') {
        metadata(block.providerFrame?.provider)
        metadata(block.providerFrame?.kind)
        textUnits += plainText ? 0 : block.text.length
        if (textUnits > 262144) {
          throw new NativeChatGalleryProjectionLimitError()
        }
      } else if (block.type === 'tool-call') {
        metadata(block.name)
        metadata(block.callId)
        metadata(block.mcpIdentity?.server)
        metadata(block.mcpIdentity?.tool)
        if (nativeChatToolCategory(block.name, block.mcpIdentity) === 'read') {
          toolInput(block.input)
        }
      } else if (block.type === 'tool-result') {
        metadata(block.callId)
      } else if (block.type === 'background-task') {
        metadata(block.summary)
        metadata(block.error)
        metadata(block.label)
      }
    }
  }
}

export function nativeChatGalleryGroupKey(
  kind: 'slot' | 'reasoning',
  message: Pick<NativeChatMessage, 'id'>
): string {
  if (message.id.length > 1024) {
    throw new NativeChatGalleryProjectionLimitError()
  }
  return `${kind}:${message.id}`
}
