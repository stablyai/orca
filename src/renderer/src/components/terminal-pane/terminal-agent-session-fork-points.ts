import { translate } from '@/i18n/i18n'
import type { RuntimeAgentSessionForkPointOption } from '../../../../shared/runtime-types'

export const CURRENT_FORK_POINT_VALUE = 'current-end'
const MESSAGE_FORK_POINT_VALUE_PREFIX = 'message:'

export function toMessageForkPointValue(messageId: string): string {
  return MESSAGE_FORK_POINT_VALUE_PREFIX.concat(messageId)
}

export function getMessageIdFromForkPointValue(value: string): string | undefined {
  if (!value.startsWith(MESSAGE_FORK_POINT_VALUE_PREFIX)) {
    return undefined
  }
  const messageId = value.slice(MESSAGE_FORK_POINT_VALUE_PREFIX.length).trim()
  return messageId.length > 0 ? messageId : undefined
}

export function formatForkPointOptionLabel(
  option: RuntimeAgentSessionForkPointOption,
  index: number
): string {
  const prompt =
    option.prompt.trim() ||
    translate(
      'auto.components.terminal.pane.TerminalAgentSessionForkDialog.promptUnavailable',
      'Prompt text unavailable'
    )
  return translate(
    'auto.components.terminal.pane.TerminalAgentSessionForkDialog.messageForkPointOption',
    'Message {{index}}: {{prompt}}'
  )
    .replace('{{index}}', String(index + 1))
    .replace('{{prompt}}', prompt)
}
