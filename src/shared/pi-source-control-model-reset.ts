import {
  clearSourceControlAiModelChoiceForHost,
  readSourceControlAiModelChoiceForHost
} from './source-control-ai-model-selection'
import { PI_DEFAULT_MODEL_ID } from './pi-configured-default-model'
import { UNKNOWN_COMMIT_MESSAGE_HOST_KEY } from './commit-message-host-key'
import type { SourceControlAiSettings } from './source-control-ai-types'

export function hasSavedPiSourceControlModel(
  settings: SourceControlAiSettings,
  hostKey: string
): boolean {
  if (hostKey === UNKNOWN_COMMIT_MESSAGE_HOST_KEY) {
    return false
  }
  return [settings, ...Object.values(settings.modelOverridesByOperation ?? {})].some((choice) => {
    const model = readSourceControlAiModelChoiceForHost(choice, hostKey, 'pi')
    return model !== undefined && model !== PI_DEFAULT_MODEL_ID
  })
}

export function resetPiSourceControlModelsForHost(
  settings: SourceControlAiSettings,
  hostKey: string
): SourceControlAiSettings {
  if (hostKey === UNKNOWN_COMMIT_MESSAGE_HOST_KEY) {
    return settings
  }
  const choice = clearSourceControlAiModelChoiceForHost(settings, hostKey, 'pi')
  const overrides = { ...settings.modelOverridesByOperation }
  for (const operation of Object.keys(overrides) as (keyof typeof overrides)[]) {
    const previous = overrides[operation]
    const cleared = clearSourceControlAiModelChoiceForHost(previous, hostKey, 'pi')
    overrides[operation] = previous?.selectedThinkingByModel
      ? { ...cleared, selectedThinkingByModel: previous.selectedThinkingByModel }
      : cleared
  }
  return {
    ...settings,
    selectedModelByAgent: choice?.selectedModelByAgent ?? {},
    selectedModelByAgentByHost: choice?.selectedModelByAgentByHost ?? {},
    modelOverridesByOperation: overrides
  }
}
