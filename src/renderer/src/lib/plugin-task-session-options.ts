import { translate } from '@/i18n/i18n'
import type { PluginTaskStartRecipe } from '../../../shared/plugins/plugin-task-source'

export type PluginTaskSessionOptions = NonNullable<PluginTaskStartRecipe['sessionOptions']>

/** The options to launch `agent` with, or undefined when they target another agent or none is chosen. */
export function sessionOptionsForAgent(
  options: PluginTaskSessionOptions | undefined,
  agent: string | null
): Record<string, string> | undefined {
  if (!options || agent === null || (options.agent && options.agent !== agent)) {
    return undefined
  }
  const launchOptions: Record<string, string> = {}
  if (options.model) {
    launchOptions.model = options.model
  }
  if (options.effort) {
    launchOptions.effort = options.effort
  }
  return Object.keys(launchOptions).length > 0 ? launchOptions : undefined
}

/** One line for the composer saying which session options the launch uses, or why none. */
export function describePluginTaskSessionOptions(
  options: PluginTaskSessionOptions | undefined,
  agent: string | null
): string | null {
  const applied = sessionOptionsForAgent(options, agent)
  if (!applied) {
    return options?.agent &&
      agent !== null &&
      options.agent !== agent &&
      (options.model || options.effort)
      ? translate(
          'auto.components.NewWorkspaceComposerCard.agentSessionOtherAgent',
          "The task's model and effort are for {{agent}}, so this agent starts with its own.",
          { agent: options.agent }
        )
      : null
  }
  const { model, effort } = applied
  if (model && effort) {
    return translate(
      'auto.components.NewWorkspaceComposerCard.agentSessionModelEffort',
      'Starts with model {{model}}, effort {{effort}}.',
      { model, effort }
    )
  }
  return model
    ? translate(
        'auto.components.NewWorkspaceComposerCard.agentSessionModel',
        'Starts with model {{model}}.',
        {
          model
        }
      )
    : translate(
        'auto.components.NewWorkspaceComposerCard.agentSessionEffort',
        'Starts with effort {{effort}}.',
        {
          effort: effort ?? ''
        }
      )
}
