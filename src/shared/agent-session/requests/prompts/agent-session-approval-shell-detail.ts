import { isRecord } from '../../../agent-status/child-work/agent-status-child-work-value-guards'
import { isCommandToolName } from '../../../native-chat/tools/native-chat-tool-activity'
import { normalizeToolInput } from '../../../native-chat/tools/native-chat-tool-summary'

export type ShellApprovalDetail = {
  command: string
  /** Every other argument as compact JSON, the sandbox opt-out first; null when none is left. */
  otherArguments: string | null
}

/** A shell call's stored input JSON read as its command; null leaves any other detail as stored. */
export function readShellApprovalDetail(
  detail: string,
  toolName: string | undefined,
  description: string | undefined
): ShellApprovalDetail | null {
  if (toolName === undefined || !isCommandToolName(toolName)) {
    return null
  }
  const input = normalizeToolInput(detail)
  if (!isRecord(input)) {
    return null
  }
  const { command, dangerouslyDisableSandbox, description: modelDescription, ...rest } = input
  if (typeof command !== 'string') {
    return null
  }
  // Trimmed so leading blank lines cannot push the command below the collapsed clamp.
  const shownCommand = command.trim()
  if (!shownCommand) {
    return null
  }
  // The card already shows the prompt's description; the model's is dropped only when that text contains it.
  const keep = !(typeof modelDescription === 'string' && description?.includes(modelDescription))
  const otherArguments = JSON.stringify({
    dangerouslyDisableSandbox,
    ...(keep ? { description: modelDescription } : {}),
    ...rest
  })
  return {
    command: shownCommand,
    otherArguments: otherArguments === '{}' ? null : otherArguments
  }
}
