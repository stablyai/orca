import { ORCHESTRATION_LEGACY_RUN_ID } from './orchestration-rpc-contract'

export type OrchestrationMessageSummary = {
  id: string
  run_id?: string
  delivery_contract?: 'legacy_direct' | 'current_delivery' | 'audit_only'
  from_handle: string
  to_handle?: string
  subject?: string
  type?: string
  body?: string
  payload?: string | null
  priority?: string
  read?: number
}

export type LegacyCompatibilityResult = {
  recovery?: boolean
  readOnly?: boolean
  ackMessageIds?: string[]
  answerAcknowledgement?: {
    questionId: string
    answerMessageId: string
  }
  currentDelivery?: {
    runId: string
    checkCommand: string
    ackCommand: string
  }
  resumeRequired?: boolean
  resumeCommand?: string
}

export type OrchestrationCheckOutput = {
  messages: OrchestrationMessageSummary[]
  count: number
  formatted?: string
  deliveryId?: string | null
  timedOut?: boolean
  cancelled?: boolean
  connectionLost?: boolean
  legacyCompatibility?: LegacyCompatibilityResult
}

export function formatMessageReadOnlyTag(
  message: OrchestrationMessageSummary,
  legacyCompatibilityActive = false
): string {
  return isLegacyReadOnlyMessage(message, legacyCompatibilityActive) ? ' [legacy, read-only]' : ''
}

export function isLegacyReadOnlyMessage(
  message: OrchestrationMessageSummary,
  legacyCompatibilityActive = false
): boolean {
  return (
    message.run_id === ORCHESTRATION_LEGACY_RUN_ID ||
    (message.delivery_contract === 'legacy_direct' && !legacyCompatibilityActive) ||
    message.delivery_contract === 'audit_only'
  )
}

export function formatOrchestrationCheckText(
  result: OrchestrationCheckOutput,
  checkedTerminal: string
): string {
  const prepared = prepareOrchestrationCheckOutput(
    result,
    checkedTerminal,
    result.formatted !== undefined
  )
  const compatibilityActive = Boolean(
    prepared.legacyCompatibility && !prepared.legacyCompatibility.readOnly
  )
  const legacyHeader = prepared.legacyCompatibility
    ? prepared.legacyCompatibility.readOnly
      ? '[LEGACY READ-ONLY]\n'
      : prepared.legacyCompatibility.recovery
        ? '[LEGACY RECOVERY REPLAY — MAY HAVE BEEN SEEN]\n'
        : '[LEGACY COMPATIBILITY]\n'
    : ''
  const deliveryNotice = formatCurrentDeliveryNotice(prepared.legacyCompatibility?.currentDelivery)
  if (prepared.formatted) {
    return `${legacyHeader}${prepared.formatted}${deliveryNotice}`
  }
  if (prepared.count === 0) {
    if (prepared.timedOut) {
      return `${legacyHeader}Wait timed out; no messages were consumed.${deliveryNotice}`
    }
    if (prepared.cancelled) {
      const cancelled = prepared.connectionLost
        ? 'Wait cancelled because the connection closed; no messages were consumed.'
        : 'Wait cancelled; no messages were consumed.'
      return `${legacyHeader}${cancelled}${deliveryNotice}`
    }
    return `${legacyHeader}No messages.${deliveryNotice}`
  }
  const rendered = prepared.messages
    .map(
      (message) =>
        `${message.id}${formatMessageReadOnlyTag(
          message,
          compatibilityActive
        )} [${message.type ?? 'status'}] from=${message.from_handle} "${message.subject}"`
    )
    .join('\n')
  const output = prepared.deliveryId ? `Delivery ${prepared.deliveryId}\n${rendered}` : rendered
  return `${legacyHeader}${output}${deliveryNotice}`
}

export function prepareOrchestrationCheckOutput<T extends OrchestrationCheckOutput>(
  result: T,
  checkedTerminal: string,
  formattedRequested: boolean
): T {
  const compatibilityActive = Boolean(
    result.legacyCompatibility && !result.legacyCompatibility.readOnly
  )
  if (
    !formattedRequested ||
    !result.messages.some((message) => isLegacyReadOnlyMessage(message, compatibilityActive))
  ) {
    return result
  }
  return {
    ...result,
    formatted: formatLegacyAwareCheckMessages(result.messages, checkedTerminal, compatibilityActive)
  }
}

function formatMessagePriorityTag(message: OrchestrationMessageSummary): string {
  return message.priority === 'urgent' ? ' [URGENT]' : message.priority === 'high' ? ' [HIGH]' : ''
}

function escapeTerminalControlCharacters(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0)
      if (character === '\n' || (code >= 0x20 && code < 0x7f) || code > 0x9f) {
        return character
      }
      return `\\x${code.toString(16).padStart(2, '0')}`
    })
    .join('')
}

function formatQuotedMessageField(label: string, value?: string): string {
  return `[${label}]\n${escapeTerminalControlCharacters(value ?? '')
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')}`
}

function formatLegacyAwareCheckMessages(
  messages: OrchestrationMessageSummary[],
  checkedTerminal: string,
  legacyCompatibilityActive = false
): string {
  return messages
    .map((message) => {
      const legacyReadOnly = isLegacyReadOnlyMessage(message, legacyCompatibilityActive)
      const lines = [
        `${message.id}${formatMessageReadOnlyTag(message, legacyCompatibilityActive)}${formatMessagePriorityTag(message)} [${message.type ?? 'status'}] from=${message.from_handle}`,
        formatQuotedMessageField('subject', message.subject)
      ]
      if (legacyReadOnly) {
        lines.push('[Inspection only: reply and acknowledgment are unavailable.]')
      }
      if (message.body) {
        lines.push(formatQuotedMessageField('body', message.body))
      }
      if (message.payload) {
        lines.push(formatQuotedMessageField('payload', message.payload))
      }
      if (!legacyReadOnly) {
        const replyTarget = message.to_handle ?? checkedTerminal
        const replyFrom =
          replyTarget.startsWith('run:') || replyTarget.startsWith('dispatch:')
            ? ''
            : ` --from ${replyTarget}`
        lines.push(`[Reply: orca orchestration reply --id ${message.id}${replyFrom} --body "..."]`)
      }
      return lines.join('\n')
    })
    .join('\n\n')
}

function formatCurrentDeliveryNotice(
  delivery: LegacyCompatibilityResult['currentDelivery']
): string {
  if (!delivery) {
    return ''
  }
  return (
    `\n[CURRENT RUN MAIL WAITING]\n` +
    `Read: ${delivery.checkCommand}\n` +
    `Then acknowledge the delivery ID it prints: ${delivery.ackCommand}`
  )
}
