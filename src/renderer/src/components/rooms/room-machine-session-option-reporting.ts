import { normalizeClaudeSessionOptionValues } from '../../../../shared/agent-session-option-catalog'
import type {
  SessionOptionDescriptor,
  SessionOptionValue
} from '../../../../shared/native-chat-session-options'
import type { RoomParticipant } from '../../../../shared/rooms'

export function reportRoomMachineContext(
  options: readonly SessionOptionDescriptor[],
  participant: RoomParticipant
): SessionOptionDescriptor[] {
  const claude = participant.agent === 'claude' || participant.agent === 'openclaude'
  const reported: Record<string, SessionOptionValue> = {
    ...(participant.context.model ? { model: participant.context.model } : {}),
    ...(participant.context.effort ? { effort: participant.context.effort } : {}),
    ...(claude && participant.context.maxTokens !== null
      ? { contextWindow: participant.context.maxTokens >= 1_000_000 ? '1m' : 'standard' }
      : {}),
    ...(typeof participant.context.fastMode === 'boolean'
      ? { fastMode: participant.context.fastMode }
      : {})
  }
  const values = claude ? normalizeClaudeSessionOptionValues(reported) : reported
  return options.map((option) => {
    if (option.kind.currentValue !== undefined || values[option.id] === undefined) {
      return option
    }
    let value = values[option.id]
    if (
      option.id === 'model' &&
      option.kind.type === 'select' &&
      claude &&
      typeof value === 'string'
    ) {
      const normalized = normalizeClaudeSessionOptionValues({ model: value }).model
      const choice = option.kind.choices.find((candidate) => {
        const candidateValues = normalizeClaudeSessionOptionValues({ model: candidate.value })
        return (
          candidateValues.model === normalized &&
          (values.contextWindow !== '1m' || candidateValues.contextWindow === '1m')
        )
      })
      value = choice?.value ?? value
    }
    if (
      option.kind.type === 'select' &&
      typeof value === 'string' &&
      option.kind.choices.some((choice) => choice.value === value)
    ) {
      return { ...option, kind: { ...option.kind, currentValue: value }, valueSource: 'reported' }
    }
    if (option.kind.type === 'boolean' && typeof value === 'boolean') {
      return { ...option, kind: { ...option.kind, currentValue: value }, valueSource: 'reported' }
    }
    return option
  })
}
