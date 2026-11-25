import { useAppStore } from '../../../store'
import {
  normalizeUsagePercentageDisplay,
  type UsagePercentageDisplay
} from '../../../../../shared/agent-usage/display/usage-percentage-display'

export function useUsagePercentageDisplay(): UsagePercentageDisplay {
  return normalizeUsagePercentageDisplay(useAppStore((state) => state.usagePercentageDisplay))
}
