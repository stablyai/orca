import { isWebAiBrowserWorkspaceId } from '../../../shared/constants'

export function dispatchWorkspaceNewTabShortcut(
  workspaceId: string | null,
  actions: {
    openBrowserTab: () => void
    openTerminalTab: () => void
  }
): 'browser' | 'terminal' {
  if (isWebAiBrowserWorkspaceId(workspaceId)) {
    actions.openBrowserTab()
    return 'browser'
  }

  actions.openTerminalTab()
  return 'terminal'
}
