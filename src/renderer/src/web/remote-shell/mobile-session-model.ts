import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import type { StructuredPromptItem } from '../../../../shared/agent-session/view/structured-agent-session-message-projection'
import { createStructuredAgentSessionOperationId } from '../../../../shared/agent-session/lifecycle/structured-agent-session-mutation'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type { MobileChatMessage, MobilePendingInteraction } from './views/MobileChatView'

type RuntimeResponse<TResult> = {
  ok: boolean
  result?: TResult
  error?: { message?: string }
}

export async function callRuntime<TResult>(method: string, params?: unknown): Promise<TResult> {
  const response = (await window.api.runtime.call({ method, params })) as RuntimeResponse<TResult>
  if (!response.ok) {
    throw new Error(response.error?.message ?? `${method} failed`)
  }
  return response.result as TResult
}

export function operationId(): string {
  return createStructuredAgentSessionOperationId(createBrowserUuid)
}

function toolInput(input: unknown): string {
  if (input === undefined || input === null) {
    return ''
  }
  if (typeof input === 'string') {
    return input
  }
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

export function toMobileMessage(message: NativeChatMessage): MobileChatMessage {
  const text: string[] = []
  const reasoning: string[] = []
  const tools: NonNullable<MobileChatMessage['tools']> = []
  for (const block of message.blocks) {
    if (block.type === 'text') {
      if (message.role === 'reasoning') {
        reasoning.push(block.text)
      } else {
        text.push(block.text)
      }
    } else if (block.type === 'tool-call') {
      tools.push({
        name: block.name,
        input: toolInput(block.input),
        state: block.state
      })
    } else if (block.type === 'tool-result') {
      const last = tools.at(-1)
      if (last && last.output === undefined) {
        last.output = block.output
      } else {
        tools.push({ name: 'tool result', output: block.output })
      }
    } else if (block.type === 'image-ref') {
      text.push(block.alt ?? '[image]')
    }
  }
  return {
    id: message.id,
    role:
      message.role === 'user'
        ? 'user'
        : message.role === 'assistant'
          ? 'assistant'
          : message.role === 'reasoning'
            ? 'reasoning'
            : 'system',
    content: text.join('\n').trim(),
    ...(reasoning.length > 0 ? { reasoning: reasoning.join('\n').trim() } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    timestamp: message.timestamp ?? undefined
  }
}

export function pendingInteractionFor(
  item: StructuredPromptItem | undefined
): MobilePendingInteraction | null {
  if (!item) {
    return null
  }
  const body = item.body
  return {
    interactionId: item.itemId,
    revision: item.revision,
    kind: body.kind,
    title: body.kind === 'approval' ? body.title : 'Agent question',
    command:
      body.kind === 'approval' ? (body.detail ?? body.description ?? body.title) : body.question,
    dangerLevel:
      body.kind === 'approval' && /rm |delete|drop|force|sudo/i.test(body.detail ?? '')
        ? 'high'
        : undefined,
    options: body.options.map((option) => ({ id: option.id, label: option.label }))
  }
}

export function pickOption(
  item: StructuredPromptItem,
  decision: 'approve' | 'deny'
): { id: string; label: string } | null {
  const options = item.body.options
  if (options.length === 0) {
    return null
  }
  const allow = /allow|approve|accept|yes|允许|同意|执行/i
  const deny = /deny|reject|decline|no|拒绝|取消/i
  const pattern = decision === 'approve' ? allow : deny
  const matched = options.find((option) => pattern.test(option.label))
  if (matched) {
    return matched
  }
  const fallback = decision === 'approve' ? options[0] : options.at(-1)
  return fallback ?? null
}
