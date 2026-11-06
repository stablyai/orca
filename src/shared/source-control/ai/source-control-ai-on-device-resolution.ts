import {
  ON_DEVICE_TEXT_GENERATION_ID,
  ON_DEVICE_TEXT_GENERATION_MODEL_ID
} from '../../on-device-text-generation'
import type { SourceControlAiPrCreationDefaults } from './settings/source-control-ai-settings-types'
import type { ResolveSourceControlAiResult } from './source-control-ai-operation-resolution'

export function resolveOnDeviceSourceControlAi(args: {
  commandInputTemplate: string
  customPrompt?: string
  prCreationDefaults: Required<SourceControlAiPrCreationDefaults>
}): ResolveSourceControlAiResult {
  return {
    ok: true,
    value: {
      enabled: true,
      params: {
        agentId: ON_DEVICE_TEXT_GENERATION_ID,
        model: ON_DEVICE_TEXT_GENERATION_MODEL_ID,
        commandInputTemplate: args.commandInputTemplate,
        ...(args.customPrompt ? { customPrompt: args.customPrompt } : {})
      },
      prCreationDefaults: args.prCreationDefaults
    }
  }
}
