import { useAppStore } from '../../store'
import type { StatusBarItem } from '../../../../shared/types'
import { isStatusBarItemAvailable } from './status-bar-agent-gating'
import { isStatusBarItemSupportedOnPlatform } from './status-bar-platform-support'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'

/** Subscribes to detected-agent state and returns the toggles filtered to
 *  those whose underlying CLI is installed (or pre-detection). */
export function useAvailableStatusBarToggles<T extends { id: StatusBarItem }>(
  toggles: readonly T[]
): T[] {
  const detectedAgentIds = useAppStore((s) => s.detectedAgentIds)
  const platform = getRendererAppPlatform()
  return toggles.filter(
    (toggle) =>
      isStatusBarItemAvailable(toggle.id, detectedAgentIds) &&
      isStatusBarItemSupportedOnPlatform(toggle.id, platform)
  )
}
