import type { GlobalSettings } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { getSelectedAgentRuntime, type LocalAgentRuntime } from './CliSkillRuntimeSetup'

export type ComputerUseSkillRuntimeInput = {
  settings?: GlobalSettings | null
  wslSupportedPlatform?: boolean
  wslAvailable?: boolean
  wslCapabilitiesLoading?: boolean
}

export function getComputerUseSkillRuntime(input: ComputerUseSkillRuntimeInput): LocalAgentRuntime {
  if (!input.settings) {
    return {
      runtime: 'host',
      label: translate('auto.components.settings.computerUseSkillRuntime.thisDevice', 'This device')
    }
  }
  return getSelectedAgentRuntime(
    input.settings,
    input.wslSupportedPlatform ?? false,
    input.wslAvailable ?? false,
    input.wslCapabilitiesLoading ?? false
  )
}
