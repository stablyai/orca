import type { SourceControlAiSettings } from './source-control-ai-types'
import { PI_DEFAULT_MODEL_ID } from './pi-configured-default-model'
function copyRecord<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value)
}
export function prunePiConfiguredDefaultFromDiscovery(
  value: SourceControlAiSettings['discoveredModelsByAgent'] | undefined
): SourceControlAiSettings['discoveredModelsByAgent'] | undefined {
  const copied = copyRecord(value)
  if (copied?.pi) {
    copied.pi = copied.pi.filter((model) => model.id !== PI_DEFAULT_MODEL_ID)
  }
  return copied
}

export function prunePiConfiguredDefaultFromHostDiscovery(
  value: SourceControlAiSettings['discoveredModelsByAgentByHost'] | undefined
): SourceControlAiSettings['discoveredModelsByAgentByHost'] | undefined {
  const copied = copyRecord(value)
  for (const hostModels of Object.values(copied ?? {})) {
    if (hostModels?.pi) {
      hostModels.pi = hostModels.pi.filter((model) => model.id !== PI_DEFAULT_MODEL_ID)
    }
  }
  return copied
}
