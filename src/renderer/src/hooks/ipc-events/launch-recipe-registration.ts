import { useAppStore } from '../../store'
import type { PaneLaunchRecipe } from '../../../../shared/terminal-attachment-launch-result'
import { tryMakePaneKey } from './agent-status-routing'

/** Record a pane's launch recipe so a later resume replays its flags. */
export function registerLaunchRecipe(recipe: PaneLaunchRecipe): void {
  const paneKey = tryMakePaneKey(recipe.tabId, recipe.leafId)
  if (paneKey) {
    useAppStore.getState().registerAgentLaunchConfig(paneKey, recipe.launchConfig, {
      ...(recipe.launchAgent ? { agentType: recipe.launchAgent } : {}),
      ...(recipe.launchToken ? { launchToken: recipe.launchToken } : {}),
      tabId: recipe.tabId,
      leafId: recipe.leafId
    })
  }
}
