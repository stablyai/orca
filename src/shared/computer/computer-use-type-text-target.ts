import type { ComputerProviderCapabilities } from './computer-use-runtime-types'

// Why: a runtime or provider without element typing drops the target and types into whatever field has focus.
export function computerTypeTextTargetUnsupportedMessage(
  capabilities: ComputerProviderCapabilities
): string | null {
  if (capabilities.supports.actions.typeTextElement === true) {
    return null
  }
  return `${capabilities.provider} cannot type into a specific element (actions.typeTextElement); click the field, then run type-text without --element-index`
}
