import type {
  StructuredAgentSessionComposerOptions,
  StructuredAgentSessionCommandOutcome
} from './structured-agent-session-composer'
import { structuredComposerFailure } from '../failures/structured-agent-session-composer-failure'

export async function dispatchNativeReviewCommand(
  command: { name: string; argument: string },
  controller: StructuredAgentSessionComposerOptions,
  onSent?: () => void
): Promise<StructuredAgentSessionCommandOutcome | null> {
  if (command.name === 'stop') {
    if (command.argument) {
      return {
        handled: true,
        accepted: false,
        ...structuredComposerFailure('commandTakesNoArguments', { name: 'stop' })
      }
    }
    if (!controller.cleanBackgroundTerminals || !controller.cleanBackgroundTerminalsCommand) {
      return {
        handled: true,
        accepted: false,
        ...structuredComposerFailure('commandUnsupportedByHost', { name: 'stop' })
      }
    }
    const accepted = await controller.cleanBackgroundTerminalsCommand()
    if (accepted) {
      onSent?.()
    }
    return { handled: true, accepted, error: null }
  }
  if (command.name === 'review') {
    if (
      !controller.conversationCommands?.includes('review') ||
      !controller.runConversationCommand
    ) {
      return {
        handled: true,
        accepted: false,
        ...structuredComposerFailure('commandUnsupportedByHost', { name: 'review' })
      }
    }
    if (!command.argument) {
      return {
        handled: true,
        accepted: await controller.invokeAction('review', async (target, instructions) => {
          const result = await controller.runConversationCommand!(
            'review',
            instructions,
            undefined,
            target
          )
          return result
        }),
        error: null
      }
    }
    return {
      handled: true,
      ...(await controller.runConversationCommand('review', command.argument, onSent, {
        type: 'custom'
      }))
    }
  }
  return null
}
